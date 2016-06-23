// **NOTE:** This assumes you have jQuery as a node module.

var jquery = require('jquery');
var v1sdk = require('./../dist/v1sdk');

var hostname = "www14.v1host.com";
var instance = "v1sdktesting";
var username = "admin";
var password = "admin";
var port = "443";
var protocol = "https";

var v1 = new v1sdk.V1Meta({
	hostname: hostname,
	instance: instance,
	port: port,
	protocol: protocol,
	username: username,
	password: password,
	post: function (url, data, headerObj) {
		// Be sure to return jquery's jqxhr object/the post results
		return $.ajax({
			url: url,
			method: 'POST',
			data: data,
			headers: headerObj, // Include provided authorization headers { Authorization: 'Basic: .....' }
			dataType: 'json' // SDK only supports JSON from the V1 Server
		});
	}
});

// Create Asset Actual
v1.create('Actual', {Value: 5.4, Date: new Date()})
	.then(function (result) {
		console.log(result);
	})
	.catch(function (error) {
		console.log(error);
	});
