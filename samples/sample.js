var  V1Meta = require('../lib/v1meta').V1Meta;
var  V1Server = require('../lib/client').V1Server;

var hostname = "www14.v1host.com";
var instance = "v1sdktesting";
var username = "api";
var password = "api";
var port = "443";
var protocol = "https";

var server = new V1Server(hostname, instance, username, password, port, protocol);

var v1 = new V1Meta(server);

v1.query({
    from: "Member",
    where: {
        IsSelf: 'true'
    },
    select: ['Email', 'Username', 'ID'],
    success: function(result) {
        console.log(result.Email);
        console.log(result.Username);
        console.log(result.ID);
    },
    error: function(err) { // NOTE: this is not working correctly yet, not called...
        console.log(err);
    }
});
