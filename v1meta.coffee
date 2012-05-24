

client = require('./client')

class AssetClassBase
  constructor: () ->
    throw "NotImplemented"
    

class V1Meta
  constructor: (address='localhost', instance='VersionOne.Web', username='admin', password='admin') ->
    @server = new client.V1Server(address, instance, username, password)
    @global_cache = {}
    @dirtylist = []    
    
  fetch_asset_meta: (asset_type_name) ->
    callback = (error, xmldoc) ->
        if error
            throw error
        throw 'Not Implemented'
    @server.get_meta_xml(asset_type_name, callback)
    
  create_asset_class: (asset_type_name) ->
    throw "NotImplemented"
    asset_class_base = something
    new_class = asset_class_base.clone()
    xml = @fetch_asset_meta(asset_type_name)
    for attributedef in xml.definitions
      new_class[accessor] = create_accessor(...)
    return new_class
    
    
    
    
