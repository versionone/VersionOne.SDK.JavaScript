V1Meta = require('./v1meta').V1Meta
V1Server = require('./client').V1Server

server = new V1Server()

v1 = new V1Meta(server)

v1.query 
    select: ['Email', 'Username', 'ID']
    from: "Member"
    where:
        ID: 'Member:1000'
        Email : 'andre@company.com'
        Username : 'andre'
    success: (result) ->
        message = 'Email: ' + result.Email + "<br/>\n" +
                  'Username: ' + result.Username + "<br/>\n" +
                  'ID: ' + result.ID
        output = () -> 
            if server.useBrowserHttpStack
                document.getElementById("query").innerHTML += "<b>Query result:</b><br/><br/>" + message           
            else
                console.log "\nQuery result:\n\n" + message
        setTimeout(output, 2000)
    error: (err) ->
        console.log "Error: " + err

v1.trans_query 
    from: "Member"
    where:
        ID: 'Member:1000'
        Email : 'andre@company.com'
        Username : 'andre'
    select: ["Email", "ID", "Username"]
    success: (trans) ->
        message = ""
        trans.iter (member) ->
            if server.useBrowserHttpStack
                message += member + "<br/>\n"
            else  
                message += member + "\n"
        output = () -> 
            if server.useBrowserHttpStack
                document.getElementById("trans_query").innerHTML += "<b>Transaction Query result:</b><br/><br/>" + message
            else
                console.log "\nTransaction Query result:\n\n" + message
        setTimeout(output, 2000)
        #trans.commit and_log_callback
    error: (err) ->
        console.log("Query failed:\n" + util.inspect(err))

"""
v1.with_poller (poller) ->
    poller.on_new_asset 'Story',
        'CreateDate Moment Owners',
        (story) ->
            console.log story
            story.Touched = now()
    poller.commit and_log_callback
"""
    
