var  v1sdk = require('../v1sdk');

var hostname = "ec2-54-205-135-234.compute-1.amazonaws.com";
var instance = "VersionOne";
var username = "admin";
var password = "admin";
var port = "80";
var protocol = "http";

var server = new v1sdk.V1Server(hostname, instance, username, password, port, protocol);
var v1 = new v1sdk.V1Meta(server);

v1.query({
    from: "Member",
    where: {
        IsSelf: true
    },
    select: ['Email', 'Username', 'ID'], // 'OwnedWorkitems.@Count'],

    success: function(result) {
        console.log(result);
        $('#error').hide();
        $("#Email").text(result.Email);
        $("#ID").text(result.ID);
        $("#Username").text(result.Username);
        //$("#OwnedWorkitems").text(result.data['OwnedWorkitems_@Count']);
        $("#memberPanel")
            .accordion({collapsible:true})
            .show();
    },

    error: function(err) { // NOTE: this is not working correctly yet, not called...
        $('#memberPanel').hide();
        $('#error').html(err).show();
    }
});
