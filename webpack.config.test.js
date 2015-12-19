var webpack = require('webpack');
var path = require('path');
var fs = require('fs');

module.exports = {
	entry: getTestEntries(),
	target: 'node',
	output: {
		path: path.join(__dirname, './tmp'),
		filename: 'specs.js'
	},
	resolve: {
		extensions: ['', '.js', '.json', '.coffee']
	},
	module: {
		loaders: [
			{
				test: /\.(js)$/,
				exclude: /node_modules/,
				loader: 'babel-loader?plugins=rewire'
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

function getTestEntries() {
	return [
		path.join(__dirname, 'specs', 'setup.js')
	]
		.concat(specFiles(''));
}

function specFileToPath(directory) {
	return function (filename) {
		return path.join(directory, filename);
	}
}

function specFiles(directory) {
	return processDirectory(directory)
		.map(function (item) {
			return path.join(__dirname, 'specs', item);
		});
}

function processDirectory(directory) {
	var paths = fs.readdirSync(path.join(__dirname, 'specs', directory));
	var directories = paths.filter(isDirectory(directory));
	var files = paths.filter(isNotADirectory(directory))
		.filter(function (x) {
			return /\.specs\.js$/.exec(x);
		});
	return directories
		.map(processDirectory)
		.reduce(function (output, files) {
			return output.concat(files);
		}, [])
		.concat(files)
		.map(specFileToPath(directory));
}

function isDirectory(directory) {
	return function (filepath) {
		return fs.lstatSync(path.join(__dirname, 'specs', directory, filepath)).isDirectory();
	}
}

function isNotADirectory(directory) {
	return function (filepath) {
		return !isDirectory(directory)(filepath);
	}
}