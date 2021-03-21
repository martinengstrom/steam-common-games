var request = require('request-promise-native');
var coopTag = 9; // Or 38 for "Online Co-op"
var multiplayerTag = 1;

class Game {
	constructor(appId, name, image, multiplayer, coop) {
		this.appId = appId;
		this.name = name;
		this.image = image;
		this.multiplayer = multiplayer;
		this.coop = coop;
	}
}

function hasTag(gameData, tagId) {
	if (typeof gameData.categories !== 'undefined') {
		return false;
	}

	for (const category of gameData.categories) {
		if (category.id === tagId) {
			return true;
		}
	}

	return false;
}

module.exports = {
	getAppInfo: appId => {
		return request('https://store.steampowered.com/api/appdetails/?appids=' + appId).then(response => {
			return new Promise((resolve, reject) => {
				var data = JSON.parse(response);
				var gameData = data[appId];
				if (gameData.success === true) {
					var hasCoop = hasTag(gameData.data, coopTag);
					var hasMultiplayer = hasTag(gameData.data, multiplayerTag);
					var game = new Game(appId, '', '', hasMultiplayer, hasCoop);
					resolve(game);
				} else {
					var game = new Game(appId, '', '', false, false);
					resolve(game);
					// Error
				}
			});
		}).catch(err => {
			console.log(err);
		});
	}
};
