


class AssetClassBase
  initialize:
    throw "NotImplemented"
    

class V1Meta
  initialize: (address='localhost', instance='VersionOne.Web', username='admin', password='admin') ->
    @server = new V1Server address, instance, username, password
    @global_cache = {}
    @dirtylist = []    
    
  fetch_asset_meta: (asset_type_name) ->
    throw "NotImplemented"
    @server.get_meta_xml asset_type_name
    
  create_asset_class: (asset_type_name) ->
    throw "NotImplemented"
    asset_class_base = something
    new_class = asset_class_base.clone()
    xml = @fetch_asset_meta asset_type_name
    for attributedef in xml.definitions
      new_class[accessor] = create_accessor(...)
    return new_class
    
    
    
    
