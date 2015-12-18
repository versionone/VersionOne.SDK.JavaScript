var webpack = require('webpack');
var path = require('path');
var fs = require('fs');

module.exports = {
	entry: "./v1sdk.coffee",
	target: 'node',
	output: {
		path: path.join(__dirname, './dist'),
		filename: 'v1sdk.js'
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
	externals: nodeModules(),
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

function nodeModules() {
	return fs.readdirSync(path.join(__dirname, 'node_modules'))
		.filter(function (x) {
			return ['.bin'].indexOf(x) === -1;
		})
		.reduce(function (output, mod) {
			output[mod] = 'commonjs ' + mod;
			return output;
		}, {});
}
