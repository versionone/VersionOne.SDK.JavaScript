http = require('http')
https = require('https')
et = require('elementtree')
url = require('url')
querystring = require('querystring')

module.exports = 
    V1Server: class V1Server
        constructor: (@hostname='localhost', @instance='VersionOne.Web', @username='admin', @password='admin', @port=80, @protocol='http') ->
            @httplib = {http:http, https:https}[@protocol]
        
        build_url: (path, query=undefined) ->
            url = '/' + @instance + path
            if query?
                url = url + '?' + querystring.stringify(query)
            return url
        
        fetch: (options, callback) ->
            url = @build_url(options.path, options.query)
            req_options = {
                hostname: @hostname,
                port: @port,
                method: (if options.postdata? then 'POST' else 'GET'),
                path: url,
                auth: @username + ':' + @password,
                }
            request_done = (response) ->
                alldata = []
                response.on 'data', (data)->
                    alldata.push(data)
                response.on 'end', () ->
                    body = alldata.join('')
                    #console.log body
                    callback(undefined, response, body)
            request = @httplib.request(req_options, request_done)
            request.on('error', callback)
            if options.postdata?
                request.write(options.postdata)
            request.end()

        get_xml: (options, callback) ->
            mycallback = (error, response, body) ->
                if error?
                    callback(error)
                xmltree = et.parse(body).getroot()
                callback(undefined, xmltree)        
            @fetch(options, mycallback)
              
        get_meta_xml: (options, callback) ->
            path = '/meta.v1/' + options.asset_type_name
            @get_xml({path:path}, callback)
            
        get_asset_xml: (options, callback) ->
            path = '/rest-1.v1/Data/' + options.asset_type_name + '/' + options.id
            @get_xml({path: path}, callback)
           
        get_query_xml: (options, callback) ->
            path = '/rest-1.v1/Data/' + options.asset_type_name
            query = {}
            if options.where?
                query['Where'] = (name + '="' + value + '"') for name,value of options.where
            if options.select?
                query['sel'] = options.select.join(',')
            @get_xml({path: path, query: query}, callback)
            
        execute_operation: (options, callback) ->
            path = '/rest-1.v1/Data/' + options.asset_type_name + '/' + options.id
            query = {op: options.opname}
            @get_xml({path: path, query: query, postdata: ''}, callback)
            
        create_asset: (options, callback) ->
            query = undefined
            if options.context_oid?
                query = {ctx: options.context_oid}
            path = '/rest-1.v1/Data/' + options.asset_type_name
            body = et.tostring(options.xmldata)
            @get_xml({path:path, query:query, postdata:body}, callback)
            
        update_asset: (options, callback) ->
            newdata = et.tostring(options.xmldata)
            path = '/rest-1.v1/Data/' + options.asset_type_name + '/' + options.id
            @get_xml({path:path, postdata:newdata})
            
            
