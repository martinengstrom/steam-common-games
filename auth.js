module.exports = {
	restrict: function(req, res, next) {
		if (!req.user) {
			req.session.redirectTo = req.path;
			res.redirect('/login');
		} else {
			next();
		}
	}
};
