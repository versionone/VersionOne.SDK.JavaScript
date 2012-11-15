

client = require('../client')
et = require('elementtree')
meta = require('../v1meta')

server = new client.V1Server('192.168.56.1')
v1 = new meta.V1Meta(server)
console.log v1
v1.create "Story", {Name:"Created by JScript", Scope:"Scope:0"}, (err, result) ->
    return console.log err if err?
    console.log result.Number

