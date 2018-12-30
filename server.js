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
var sessionSecret = creds.sessionSecret;

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
}, function(identifier, profile, done) {
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
	secret: sessionSecret,
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
			console.log(req.session.redirectTo);
			var redirectTo = req.session.redirectTo || '/';
			delete req.session.redirectTo;
			req.session.user = req.user;
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
		lobby.users = lobby.users.filter(u => u.openId !== user.openId);
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
		requestsPerSecond: 0.65, // 200 every 5 minutes
		promiseImplementation: Promise
	});

	var promiseWrapper = function(id) { return getGameInfoApi(id).then((game) => 
		{
			db.games.insert(game, (err, doc) => {
				return game;
			});
		});
	};

	var cachedEntities = [];
	var promisedEntities = [];

	var dbLookups = games.map(id => {
		return new Promise(function(resolve, reject) {
			db.games.find({appId: id}, function(err, docs) {
			if(err)
				reject(err);

			if (docs.length > 0) {
				cachedEntities.push(docs[0]);
			} else {
				promisedEntities.push(promiseThrottle.add(promiseWrapper.bind(this, id)));
			}
			resolve();
			});
		});
	});

	Promise.all(dbLookups).then(function() {
		if (promisedEntities.length > 0) {
			Promise.all(promisedEntities).then((result) => callback(cachedEntities.concat(result)));
		} else {
			callback(cachedEntities);
		}
	});
}

function getGameInfoApi(appId, callback) {
	steamurl = 'https://store.steampowered.com/api/appdetails/?appids=' + appId;
	return new Promise(function(resolve, reject) {
		request(steamurl, function(error, response, body) {
			if (error)
				reject(error);

			console.log(body);
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

	// Find all appIds that has occured as many times as there are clients
	// Resolve its appId to a game name
	resolveGameInfos(Object.keys(count).filter(id => count[id] == games.length), function(commonGames) {
		callback(commonGames);
	});
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
		removeUserFromLobby(lobbyId, socket.request.session.user);
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
