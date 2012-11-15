




client = require('../client')
et = require('elementtree')
meta = require('../v1meta')
console.log meta

class ClientTests
    test_generate_update_doc: () ->
        console.log "yo"
        c = new meta.V1Transaction([], undefined)
        console.log c
        doc = c.generate_update_doc
            Name: "Add Story Via Chat"
            Description: "a righteous feature"
            Relation: "Story:1001134"
            Estimate: 1235
        console.log et.tostring doc

console.log "yo1"
c = new ClientTests
console.log "yo2"
c.test_generate_update_doc()


