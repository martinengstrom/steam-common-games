var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var passport = require('passport');
var SteamStrategy = require('passport-steam').Strategy;
var Datastore = require('nedb');
var session = require('express-session');
var request = require('request');
var PromiseThrottle = require('promise-throttle');
var auth = require('./auth.js');
var creds = require('./credentials.js');

var steamApiKey = creds.steamApiKey; 

Array.prototype.flatMap = function(lambda) {
	return Array.prototype.concat.apply([], this.map(lambda));
};

var db = {};
db.users = new Datastore({
	filename: 'users.db',
	autoload: true
});
db.games = new Datastore({
	filename: 'games.db',
	autoload: true
});

var lobbies = {};
class Lobby {
	constructor(id) {
		this.users = [];
		this.id = id;
	}
}

class User {
	constructor(openId, username, profilePicture, games, profile = {}) {
		this.openId = openId;
		this.games = games;
		this.username = username;
		this.profilePicture = profilePicture;
		this.profile = profile;
	}
}

passport.use(new SteamStrategy({
	returnURL: 'https://games.sigkill.me/auth/steam/return',
	realm: 'https://games.sigkill.me/',
	apiKey: steamApiKey
},
function(identifier, profile, done) {
	db.users.find({openId: identifier}, function(err, docs) {
		if (err)
			return done(err);

		var user;
		if (docs.length == 1) {
			user = docs[0];
			user.profile = profile;
			user.username = profile.displayName;
			db.users.update({openId: identifier}, user, function (err, numReplaced) {
			});
		} else if (docs.length == 0) {
			user = new User(identifier, profile.displayName, '', [], profile);
			db.users.insert(user, function (err, doc) {
			});
		} else {
			console.log("FATAL ERROR. Multuple users returned");
			return done(err);
		}
		return done(err, user);
	});
}));

var sessionMiddleware = session({
	secret: 'herpderp',
	resave: true,
	saveUninitialized: true
});

app.use(sessionMiddleware);
app.use(require('flash')());
app.use(passport.initialize());
app.use(passport.session());
app.use(require('express').static('static'));


app.get('/stats', function(req, res) {
	res.write(JSON.stringify(lobbies));
	res.end();
});

app.get('/login', function(req, res) {
	res.sendFile(__dirname + '/static/login.html');
});

app.get('/auth/steam', passport.authenticate('steam'),
	function(req, res) {
	}
);

app.get('/auth/steam/return', passport.authenticate('steam', {
		failureRedirect: '/login',
		failureFlash: true
	}),
	function(req, res) {
		updateGames(req, function(err) {
			console.log("Update games redirect:");
			console.log(req.session.redirectTo);
			var redirectTo = req.session.redirectTo || '/';
			delete req.session.redirectTo;
			req.session.user = req.user;
			console.log("redirecting to origin page after login");
			res.redirect(redirectTo);
		});
	}
);

app.get('/', auth.restrict, function(req, res) {
	// Since we are here, there was no lobby id provided. Create a new lobby
	var crypto = require('crypto');
	var id = crypto.randomBytes(16).toString("hex");
	var lobby = new Lobby(id);
	lobbies[id] = lobby;
	res.redirect('/' + id);
});

app.get('/:lobbyId', auth.restrict, function(req, res) {
	if (req.params.lobbyId in lobbies) {
		req.session.lobbyId = req.params.lobbyId;
		assignUserToLobby(req.session.lobbyId, req.user);
		res.sendFile(__dirname + '/static/main.html');
	} else {
		res.status(404).send('Lobby not found');
	}
});

function assignUserToLobby(lobbyId, user) {
	if (lobbyId in lobbies) {
		lobbies[lobbyId].users.push(user);
	} else {
		console.log("FATAL ERROR. Lobby not found when attempting to add user to lobby");
	}
}

function removeUserFromLobby(lobbyId, user) {
	if (lobbyId in lobbies) {
		var lobby = lobbies[lobbyId];
		var foundUsers = lobby.users.filter(function(user) {
			return user.openId == user.openId;
		});
		if (foundUsers.length == 1) {
			lobby.users = lobby.users.filter(user => user !== foundUsers[0]);
		}
	}
}

function addUserToLobbyIfNeeded(lobbyId, user) {
	if (lobbyId in lobbies) {
		var lobby = lobbies[lobbyId];
		if (!lobby.users.find(user => user.openId == user.openId)) {
			lobby.users.push(user);
		}
	}
}

function updateGames(req, callback) {
	getOwnedGames(steamApiKey, req.user.profile._json.steamid, function(games) {
		db.users.find({openId: req.user.openId}, function (err, docs) {
			if (docs.length == 1) {
				var user = docs[0];
				user.games = games;
				db.users.update({openId: user.openId}, user, {}, function (err, numReplaced) {
					if (!err) {
						// Forces the session to update with the new user/games
						req.login(docs[0], function (err) {
							callback(err);
						});
					} else callback(err);
				});
			}
		});
	});
}


function getOwnedGames(apiKey, steamUserId, callback) {
	steamurl = 'http://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=' + apiKey + 
		'&steamid=' + steamUserId + 
		'&include_appinfo=1' +
		'&include_played_free_games=1' +
		'&format=jsonwq';
	request({url: steamurl}, function(error, response, body) {
		if (Object.keys(JSON.parse(body).response).length === 0)
			callback([]);
		else
			callback(JSON.parse(body).response.games);
	});
}

// Accepts array of gameIds
function resolveGameInfos(games, callback) {
	var promiseThrottle = new PromiseThrottle({
		requestsPerSecond: 0.1,
		promiseImplementation: Promise
	});

	var promiseWrapper = function(id) { return getGameInfoApi(id); };

	var cachedEntities = [];
	var promisedEntities = [];

	var dbLookups = games.map(id => {
		return new Promise(function(resolve, reject) {
			db.games.find({appId: id}, function(err, docs) {
			if(err)
				reject(err);

			if (docs.length > 0) {
				console.log("Found cached game");
				cachedEntities.push(docs[0]);
			} else {
				console.log("Fetching game from steam");
				promisedEntities.push(promiseThrottle.add(promiseWrapper.bind(this, id)));
			}
			resolve();
			});
		});
	});

	Promise.all(dbLookups).then(function() {
		if (promisedEntities.length > 0) {
			Promise.all(promisedEntities).then(function(result) {
				console.log("api requests done");
				var dbInserts = result.map(game => new Promise(function(resolve, reject) {
					db.games.insert(game, function(err, doc) {
						if (err)
							reject(err);
						else
							resolve(doc);
					});
				}));
				Promise.all(dbInserts).then(function() {callback(cachedEntities.concat(result))});
			});
		} else {
			console.log("Cached games only returned");
			callback(cachedEntities);
		}
	});
}

function getGameInfo(appId) {
	return new Promise(function(resolve, reject) {
		db.games.find({appId: appId}, function(err, docs) {
			if (err)
				reject(err);

			if (docs.length == 0)
				getGameInfoApi(appId, function(result) {
					if (result == null) {
						reject(result);
					} else {
						console.log("Inserting new game with appid " + appId);
						db.games.insert(result, function(err, doc) {
							if (!err)
								resolve(doc);
							else
								reject(err);
						});
					}
				});
				/*
				Promise.all(getGameInfoApi(appId)).then(function(result) {
					db.insert(result, function(err, doc) {
						if (err)
							reject(err);
						else
							resolve(result);
					});				
				}).catch(function(err) {
					console.log("Error fetching with:");
					console.log(err);
				});
				*/
			else
				resolve(docs[0]);
		});
	});
}

function getGameInfoApi(appId, callback) {
	steamurl = 'https://store.steampowered.com/api/appdetails/?appids=' + appId;
	return new Promise(function(resolve, reject) {
		request(steamurl, function(error, response, body) {
			if (error)
				reject(error);

			var data = JSON.parse(body)[appId].data;
			var multiplayer = data.categories.find(c => c.id == 1);
			var coop = data.categories.find(c => c.id == 9);
			resolve({
				appId: appId,
				name: data.name,
				image: data.header_image,
				multiplayer: (multiplayer != null),
				coop: (coop != null)
			});
		});
	});
}

function getCommonGames(games, callback) {
	// Count occurences per appId count[appId] = count
	var allGames = games.flatMap(p => p.flatMap(c => c.appid));
	var count = {};
	allGames.forEach(function (i) { count[i] = (count[i]||0) + 1;});

	/*
	var pto = new PromiseThrottle({
		requestsPerSecond: 0.1,
		promiseImplementation: Promise
	});
	*/

	//var promiseWrapper = function(id) { return getGameInfo(id); };

	// Find all appIds that has occured as many times as there are clients
	// Resolve its appId to a game name
	//var commonGames = resolveGameInfos(Object.keys(count).filter(id => count[id] == games.length));
	console.log("Getting common games..");
	resolveGameInfos(Object.keys(count).filter(id => count[id] == games.length).slice(0, 3), function(commonGames) {
		console.log("Common games:");
		console.log(commonGames);
		callback(commonGames);
	});
	
	//	.map(async id => getGameInfo(id));
	//	.map(async id => pto.add(promiseWrapper.bind(this, id)));
	//	.map(id => games.flatMap(p => p.find(c => c.appid == id).name)[0]);

	/*
	Promise.all(commonGames).then(function(result) {
		return result;
	});
	*/
	//Promise.all(commonGames).then(function(result){return result});
	//Promise.all(commonGames.map(task => promiseThrottle.add(task))).then(function(result){return result});
	//return commonGames;
}

function getLobbyUserNicknames(lobbyId) {
	if (lobbyId in lobbies) {
		var lobby = lobbies[lobbyId];
		var nicks = lobby.users.map(user => user.username);
		return nicks;
	}
	return [];
}

io.use(function(socket, next) {
	sessionMiddleware(socket.request, socket.request.res, next);
});

io.on('connection', function(socket) {
	console.log("connection");
	if (!socket.request.session.user || !socket.request.session.user.profile)
		return;

	var lobbyId = socket.request.session.lobbyId;
	var broadcastUpdates = function(socket, lobbyId) {
		io.to(lobbyId).emit('users', getLobbyUserNicknames(lobbyId));
		broadcastCommonGames(socket, lobbyId);
	};

	// Sometimes a connection dies and recreates itself during a session
	// so make sure the user gets re-added if that happens
	addUserToLobbyIfNeeded(lobbyId, socket.request.session.user);

	socket.join(lobbyId);
	console.log("Sending updates due to new connection");
	broadcastUpdates(socket, lobbyId);
	socket.on('disconnect', function() {
		removeUserFromLobby(lobbyId, socket.request.user);
		console.log("Sending updates due to disconnect");
		broadcastUpdates(socket, lobbyId);
	});
});

function broadcastCommonGames(socket, lobbyId) {
	console.log("Broadcasting games to lobby id " + lobbyId);
	if (lobbyId in lobbies) {
		var lobby = lobbies[lobbyId];
		// Only emit games if there are more than 1 users
		//if (lobby.users.length > 1) {
			var allGamesArray = lobby.users.map(user => user.games);
			getCommonGames(allGamesArray, (games) => io.to(lobbyId).emit('games', games));
		//}
	} else {
		console.log("FATAL ERROR. No lobby found when attempting to broadcast games");
	}
}

passport.serializeUser(function(user, done) {
	done(null, user.openId);
});

passport.deserializeUser(function(id, done) {
	db.users.find({ openId: id }, function (err, docs) {
		if (docs.length == 1)
			done(err, docs[0]);
		else
			done(err);
	});

});

http.listen(3000, function() {
	console.log('Listening on 3000');
});
