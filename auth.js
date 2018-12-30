module.exports = {
	restrict: function(req, res, next) {
		if (!req.user) {
			console.log("IN AUTH. REQ PATH:");
			console.log(req.path);
			req.session.redirectTo = req.path;
			res.redirect('/login');
		} else {
			next();
		}
	}
};
