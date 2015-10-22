var webpack = require('webpack');
var path = require('path');

module.exports = {
	entry: "./v1sdk.coffee",
	output: {
		path: path.join(__dirname, './dist/index.js'),
		filename: 'v1jssdk.js',
		library: 'v1jssdk',
		libraryTarget: 'umd'
	},
	module: {
		resolve: ['', '.js', '.json'],
		loaders: [
			{
				test: /\.(js)$/,
				exclude: /node_modules/,
				loader: 'babel-loader'
			}
		],
		loaders: [
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