et = require('elementtree')
url = require('url')
querystring = require('querystring')

# * base64.js - Base64 encoding and decoding functions
# *
# * See: http://developer.mozilla.org/en/docs/DOM:window.btoa
# *      http://developer.mozilla.org/en/docs/DOM:window.atob
# *
# * Copyright (c) 2007, David Lindquist <david.lindquist@gmail.com>
# * Released under the MIT license
# 
if typeof btoa is "undefined"
  btoa = (str) ->
    chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
    encoded = []
    c = 0
    while c < str.length
      b0 = str.charCodeAt(c++)
      b1 = str.charCodeAt(c++)
      b2 = str.charCodeAt(c++)
      buf = (b0 << 16) + ((b1 or 0) << 8) + (b2 or 0)
      i0 = (buf & (63 << 18)) >> 18
      i1 = (buf & (63 << 12)) >> 12
      i2 = (if isNaN(b1) then 64 else (buf & (63 << 6)) >> 6)
      i3 = (if isNaN(b2) then 64 else (buf & 63))
      encoded[encoded.length] = chars.charAt(i0)
      encoded[encoded.length] = chars.charAt(i1)
      encoded[encoded.length] = chars.charAt(i2)
      encoded[encoded.length] = chars.charAt(i3)
    encoded.join ""

if typeof atob is "undefined"
  atob = (str) ->
    chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
    invalid =
      strlen: (str.length % 4 isnt 0)
      chars: new RegExp("[^" + chars + "]").test(str)
      equals: (RegExp("=").test(str) and (RegExp("=[^=]").test(str) or RegExp("={3}").test(str)))

    throw new Error("Invalid base64 data")  if invalid.strlen or invalid.chars or invalid.equals
    decoded = []
    c = 0
    while c < str.length
      i0 = chars.indexOf(str.charAt(c++))
      i1 = chars.indexOf(str.charAt(c++))
      i2 = chars.indexOf(str.charAt(c++))
      i3 = chars.indexOf(str.charAt(c++))
      buf = (i0 << 18) + (i1 << 12) + ((i2 & 63) << 6) + (i3 & 63)
      b0 = (buf & (255 << 16)) >> 16
      b1 = (if (i2 is 64) then -1 else (buf & (255 << 8)) >> 8)
      b2 = (if (i3 is 64) then -1 else (buf & 255))
      decoded[decoded.length] = String.fromCharCode(b0)
      decoded[decoded.length] = String.fromCharCode(b1)  if b1 >= 0
      decoded[decoded.length] = String.fromCharCode(b2)  if b2 >= 0
    decoded.join ""

browserAjaxRequest = (method, path, auth, callback) ->
    if (typeof @XMLHttpRequest == "undefined")  
        @XMLHttpRequest = ->
            try
                return new ActiveXObject("Msxml2.XMLHTTP.6.0")
            catch error
            try
                return new ActiveXObject("Msxml2.XMLHTTP.3.0")
            catch error
            try
                return new ActiveXObject("Microsoft.XMLHTTP")
            catch error
                throw new Error("This browser does not support XMLHttpRequest.")
    req = new @XMLHttpRequest(method, path)

    req.addEventListener 'readystatechange', ->
        if req.readyState is 4                          # ReadyState Compelte
            if req.status is 200 or req.status is 304   # Success result codes
                callback req.responseText
            else
                console.log 'Error loading data. Request.readyState = ' + req.readyState         
    # Return a function that open calling will complete the work
    return () ->
        req.open method, path, false
        req.setRequestHeader "Authorization", "Basic " + btoa(auth)
        req.send()

module.exports = 
    V1Server: class V1Server
        constructor: (@hostname='localhost', @instance='VersionOne.Web', @username='admin', @password='admin', @port=80, @protocol='http', @useBrowserHttpStack=null) ->
            return @

        build_url: (path, query=undefined) ->
            url = '/' + @instance + path
            if query?
                url = url + '?' + querystring.stringify(query)
            return url

        httplibs: {
            "http": require('http'),
            "https": require('https'),
            "http://": require('http'),
            "https://": require('https')
            }
            
        fetch: (options, callback) ->         
            if not @useBrowserHttpStack?
                @useBrowserHttpStack = typeof XMLHttpRequest != "undefined"
            if @useBrowserHttpStack
                @fetch_browser options, callback
            else
                if not @httplib?
                    @httplib = @httplibs[@protocol]
                @fetch_node options, callback

        fetch_browser: (options, callback) ->
            url = @build_url(options.path, options.query)
            req_options =
                hostname: @hostname,
                port: @port,
                method: (if options.postdata? then 'POST' else 'GET'),
                path: url,
                auth: @username + ':' + @password                        
            request = browserAjaxRequest req_options.method, @protocol + "://" + req_options.hostname + ":" + req_options.port + "/" + req_options.path, req_options.auth, (data) ->
                callback(undefined, null, data) # null being the node "response". TODO: should wrap?
            request()

        fetch_node: (options, callback) ->
            url = @build_url(options.path, options.query)
            req_options =
                hostname: @hostname,
                port: @port,
                method: (if options.postdata? then 'POST' else 'GET'),
                path: url,
                auth: @username + ':' + @password                            
            request_done = (response) ->
                alldata = []
                response.on 'data', (data)->
                    alldata.push(data)
                response.on 'end', () ->
                    body = alldata.join('')                    
                    if response.statusCode != 200
                        callback(response.statusCode, response, body)
                    else
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
            
            
