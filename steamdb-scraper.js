var request = require('request-promise-native');
var coopTag = 1685;
var multiplayerTag = 3859;

class Game {
	constructor(appId, name, image, multiplayer, coop) {
		this.appId = appId;
		this.name = name;
		this.image = image;
		this.multiplayer = multiplayer;
		this.coop = coop;
	}
}

function hasTag(text, tagId) {
	return text.indexOf('tagid=' + tagId + '"') > -1;
}

module.exports = {
	getAppInfo: appId => {
		return request('https://steamdb.info/app/'+appId+'/info/').then(html => {
			return new Promise((resolve, reject) => {
				var regex = /store_tags<\/td>\n(.*)\n/g
				if (html.match(regex)) {
					var storeTags = html.match(regex)[0];
					var hasCoop = hasTag(storeTags, coopTag);
					var hasMultiplayer = hasTag(storeTags, multiplayerTag);
					var game = new Game(appId, '', '', hasMultiplayer, hasCoop);	
					resolve(game);
				} else {
					var game = new Game(appId, '', '', false, false);
					resolve(game);
				}
			});
		});
	}
};
