

client = require('./client')
et = require('elementtree')


class AssetClassBase
    constructor: (@_v1_id, @_v1_transaction) ->
        @_v1_new_data = {}
        @_v1_current_data = {}
    with_data: (data) ->
        @_v1_current_data = data
        return @
    pending: (data) ->
        @_v1_new_data = data
        return @
    create_in_context: (asste_type, data) ->
        pass
    _v1_get: (attr) ->
        return @v1_new_data[attr] ? @_v1_current_data[attr]
    _v1_set: (attr, value) ->
        if not @_v1_transaction?
            throw "Properties may only be set on assets having a _v1_transaction"
        @_v1_new_data[attr] = value
        @_v1_transaction.add_to_dirty(@)
        

class V1Transaction
    constructor: (@query_results=[], @v1meta) ->
        @dirty_assets = []
        
    add_to_dirty: (asset) ->
        if asset not in @dirty_asset
            @dirty_assets.push asset
        
    create: (asset_type, data) ->
        @v1meta.get_asset_class asset_type, (err, AssetClass) =>
            new_asset = new AssetClass(undefined, @)
            new_asset.pending(data)
            @add_to_dirty(new_asset)
        
    iter: (callback) ->
        for asset in @query_results
            callback(asset)
            
    commit: (callback) ->
        for dirty_asset in @dirty_assets
            @v1meta.update_asset dirty_asset, (err, update_result) =>
                callback(err, dirty_asset, update_result)    
        
module.exports = 
    V1Meta: class V1Meta
        constructor: (address='localhost', instance='VersionOne.Web', username='admin', password='admin') ->
            @server = new client.V1Server(address, instance, username, password)
            @global_cache = {}
                    
        for_all_types: (callback) ->
            @server.get_meta_xml {asset_type_name: ''}, (err, meta_xml) =>
                if not err?
                    meta_xml.iter 'AssetType', (asset_xml) =>
                        callback(@build_asset_class_from_xml(asset_xml))
        
        build_asset_class_from_xml: (xml) ->
            asset_type_name = xml.get('name')
            
            cls = class extends AssetClassBase
                    _v1_asset_type_name: asset_type_name
                    _v1_v1meta: @
                    _v1_ops: []
                    _v1_attrs: []
                    
            xml.iter 'Operation', (operation) =>
                opname = operation.get('name')
                cls::_v1_ops.push(opname)
                cls.prototype[opname] = () =>
                    @_v1_execute_operation(opname)
                    
            xml.iter 'AttributeDefinition', (attribute) =>
                attr = attribute.get('name')
                cls::_v1_attrs.push(attr)
                
                if attribute.get('attributetype') == 'Relation'
                    setter = (value) =>
                        @_v1_set(attr, value)
                    getter = () =>
                        @_v1_get(attr)
                    
                if attribute.get('ismultivalue') != 'True'
                    setter = (value) =>
                        @_v1_set(attr, value)
                    getter = () =>
                        @_v1_get(attr)
                    
                Object.defineProperty cls.prototype, attr, 
                    get: getter
                    set: setter
                    enumerable: true
                    
            return cls
            
        build_asset: (AssetClass, assetxml, trans) ->
            oidtoken = assetxml.get('id')
            asset = new AssetClass(oidtoken, trans)
            
            for attrxml in assetxml.findall('Attribute')
                attrname = attrxml.get('name').replace(".", "_")
                asset._v1_current_data[attrname] = attrxml.text
                
            for relxml in assetxml.findall('Relation')
                relname = relxml.get('name').replace(".", "_")
                asset._v1_current_data[relname] ?= []
                for rel in relxml.findall("Asset")
                    asset._v1_current_data[relname].push rel.get('idref')
            
            return asset
        
        query: (options, callback) ->
            @get_asset_class options.asset_type_name, (err, Cls) =>
                return callback(err) if err?
                @server.get_query_xml options, (err, xmlresults) =>
                    callback(err) if err?
                    for assetxml in xmlresults.findall('.Asset')
                        asset = @build_asset(Cls, assetxml)
                        callback(undefined, asset)
            
        trans_query: (options, callback) ->
            @get_asset_class options.asset_type_name, (err, Cls) =>
                return callback(err) if err?
                @server.get_query_xml options, (err, xmlresults) =>
                    return callback(err) if err?
                    trans = new V1Transaction([], @)
                    assets = (@build_asset(Cls, asset, trans) for asset in xmlresults.findall('.Asset'))
                    trans.query_results = assets
                    callback(undefined, trans)
                        
        get_asset_class: (asset_type_name, callback) =>     
            if asset_type_name of @global_cache
                callback(undefined, @global_cache[asset_type_name])
            else
                @server.get_meta_xml {asset_type_name: asset_type_name}, (error, xml) =>
                    return callback(error) if error?
                    cls = @build_asset_class_from_xml(xml)
                    @global_cache[asset_type_name] = cls
                    callback(undefined, cls)

                    
                
                

        
