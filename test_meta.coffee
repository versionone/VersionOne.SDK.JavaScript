V1Meta = require('./v1meta').V1Meta

v1 = new V1Meta()

now = () -> new Date().toISOString()

and_log_callback = (err, updated_asset) ->
    if err?
        console.log "Error!"
    else
        console.log 'Wrote: ' + updated_asset.toString()
    

v1.query "Story",
    where: Name: 'New Story'
    select: 'Name CreateDate Owners Estimate'
    callback: (err, transaction) ->
        if err?
            return console.log("query failed\n" + util.inspect(err)) 
        transaction.iter (story) ->
            story.Name = 'Something Else'
            issue = Story.create_in_context('Issue', {Name: 'New Issue'})
        transaction.commit and_log_callback


v1.with_poller (poller) ->
    poller.on_new_asset 'Story',
        'CreateDate Moment Owners',
        (story) ->
            console.log story
            story.Touched = now()
    poller.commit and_log_callback

    
