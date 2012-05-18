
description = "


"


class AssetClassBase
  initialize:
    true
    

class V1Meta
  initialize:
    true
    
  create_asset_class: (asset_type_name) ->
    asset_class_base = something
    new_class = asset_class_base.clone()
    for attributedef in xml.definitions
      new_class[accessor] = create_accessor(...)
    return new_class
    
    
    
    
