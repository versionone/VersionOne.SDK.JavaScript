V1Meta = require('./v1meta').V1Meta
V1Server = require('./client').V1Server

server = new V1Server()

v1 = new V1Meta(server)

now = () -> new Date().toISOString()

and_log_callback = (err, updated_asset) ->
    if err?
        console.log "Error!"
    else
        console.log 'Wrote: ' + updated_asset.toString()

v1.query "Member"
    where:
        ID: 'Member:1000'
        Email : 'andre@company.com'
        Username : 'andre'
    ,(err, transaction) ->
        if err?
            return console.log("query failed\n" + util.inspect(err))         
        transaction.iter (member) ->
            console.log member
        #transaction.commit and_log_callback
"""
v1.with_poller (poller) ->
    poller.on_new_asset 'Story',
        'CreateDate Moment Owners',
        (story) ->
            console.log story
            story.Touched = now()
    poller.commit and_log_callback
"""
    
