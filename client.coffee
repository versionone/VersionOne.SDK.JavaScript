
http = require 'http'
elementtree = require 'elementtree'




class V1Server
  initialize: (address='localhost', instance='VersionOne.Web', username='', password='') ->
    @address = address
    @instance = instance
    @username = username
    @password = password
    
  uses_netloc: ['ftp', 'http', 'gopher', 'nntp', 'telnet', 'imap', 'wais',
               'file', 'mms', 'https', 'shttp', 'snews', 'prospero', 'rtsp',
               'rtspu', 'rsync', '', 'svn', 'svn+ssh', 'sftp','nfs','git',
               'git+ssh']
                   
  urlunsplit: (scheme, netloc, url, query, fragment) ->
    # mostly copied from http://hg.python.org/cpython/file/2.7/Lib/urlparse.py
    if netloc or (scheme and (scheme in @uses_netloc) and (url.slice(null,2) != '//'))
      if url and (url.slice(null,1) != '/')
        url = '/' + url
    if scheme
      url = scheme + ':' + url
    if query
      url = url + '?' + query
    if fragment
      url = url + '#' + fragment
    return url
  
  urlunparse: (scheme, netloc, url, params, query, fragment) ->
    # mostly copied from http://hg.python.org/cpython/file/2.7/Lib/urlparse.py
    if params
      url = url + ';' + params
    return @urlunsplit(scheme, netloc, url, query, fragment)

    
  build_url: (path, query='', fragment='', params='', port=80, protocol='http') ->
    path = @instance + path
    if (typeof query) != 'string'
      query = encodeURIComponent(name) + '=' + encodeURIComponent(value) for name,value of query
    url = @urlunparse(protocol, self.address, path, params, query, fragment)
    return url
    
  fetch: (path, query='', postdata) ->
    throw "NotImplemented"
    url = @build_url(path, query=query)
    try
      if postdata
        response = http_post url, @username, @password, postdata
      else
        response = http_get url, @username, @password
      body = response.read()
      return {error: null, body: body}
    catch error
      body = response.read()
      return {error: error, body: body} 
      
  build_url: () ->
    throw "NotImplemented"
  get_xml: () ->
    throw "NotImplemented"
  get_meta_xml: () ->
    throw "NotImplemented"
  get_asset_xml: () ->
    throw "NotImplemented"
  get_single_attribute_value: () ->
    throw "NotImplemented"
  
  


  

