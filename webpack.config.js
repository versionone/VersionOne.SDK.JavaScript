var webpack = require('webpack');
var path = require('path');

module.exports = {
	entry: "./v1sdk.coffee",
	output: {
		path: path.join(__dirname, './dist'),
		filename: 'v1sdk.js',
		library: 'v1sdk',
		libraryTarget: 'umd'
	},
	resolve: {
		extensions: ['', '.js', '.json', '.coffee']
	},
	module: {
		loaders: [
			{
				test: /\.(js)$/,
				exclude: /node_modules/,
				loader: 'babel-loader'
			},
			{
				test: /\.(coffee)$/,
				exclude: /node_modules/,
				loader: 'coffee-loader'
			}
		]
	},
	plugins: [
		new webpack.optimize.DedupePlugin(),
		new webpack.optimize.OccurenceOrderPlugin()
	],
	babel: {
		stage: 2,
		loose: ['all'],
		optional: ['runtime']
	}
};
