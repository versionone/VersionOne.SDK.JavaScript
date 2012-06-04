

client = require('./client')
et = require('elementtree')


class AssetClassBase
    constructor: () ->
        @_v1_new_data = {}
        @_v1_current_data = {}
        @_v1_needs_refresh = true
    with_data: (data) ->
        @_v1_current_data = data
        return @
    pending: (data) ->
        @_v1_new_data = data
        return @
    create_in_context: (asste_type, data) ->
        pass
    getName: () ->
        return @_v1_asset_type_name
    _v1_get: (attr) ->
        if attr of @v1_new_data
            return @v1_new_data[attr]
        if @_v1_needs_refresh
            @_v1_refresh()
        if attr not of @v1_current_data
            @_v1_get_single_attr(attr)
        return @_v1_current_data[attr]
    _v1_set: (attr, value) ->
        @_v1_new_data[attr] = value
        @_v1_meta.add_to_dirty(@)
    _v1_refresh: () ->
        @_v1_
    _v1_commit: () ->
        @_v1_meta.update_asset(@_v1_asset_type, @id, @_v1_new_data)
        @_v1_current_data = {}
        @_v1_new_data = {}
        @_v1_needs_refresh = true


class V1Transaction
    constructor: () ->
        @pass = 'pass'
    create: (asset_type, data) ->
        throw 'NotImplemented'
    iter: (callback) ->
        throw 'NotImplemented'
        for asset in @query_results
            callback(asset)
    commit: (callback) ->
        for dirty_asset in @dirty_assets
            dirty_asset._v1_commit(callback)
        
module.exports = 
    V1Meta: class V1Meta
        constructor: (address='localhost', instance='VersionOne.Web', username='admin', password='admin') ->
            @server = new client.V1Server(address, instance, username, password)
            @global_cache = {}
            @dirtylist = []
            
        #execute:  (user_func) ->
        #    return Fiber(()->user_func(this)).run()
                    
        for_all_types: (callback) ->
            v1meta = this
            @server.get_meta_xml {asset_type_name: ''}, (err, xml) ->
                if err?
                    callback(err)
                else
                    classes = []
                    xml.iter 'AssetType', (typexml) ->
                        cls = v1meta.build_asset_class_from_xml(typexml)
                        consoel.log cls::_v1_asset_type_name
                        classes.push(cls)
                    console.log classes.length + " Classes read"
                    callback(undefined, classes)
                    
            
        build_asset_class_from_xml: (xml) ->
            #console.log "Asset class"
            #console.log et.tostring(xml)
            asset_type_name = xml.get('name')
            cls = class extends AssetClassBase
                    _v1_asset_type_name: asset_type_name
                    _v1_v1meta: @
                    _v1_ops: []
                    _v1_attrs: []
                    constructor: (@id) ->
            xml.iter 'Operation', (operation) ->
                opname = operation.get('name')
                cls::_v1_ops.push(opname)
                cls.prototype[opname] = () ->
                    @_v1_execute_operation(opname)
            xml.iter 'AttributeDefinition', (attribute) ->
                attr = attribute.get('name')
                cls::_v1_attrs.push(attr)
                if attribute.get('attributetype') == 'Relation'
                    setter = (value) -> @_v1_set(attr, value)
                    getter = () -> @_v1_get(attr)
                if attribute.get('ismultivalue') != 'True'
                    setter = (value) -> @_v1_set(attr, value)
                    getter = () -> @_v1_get(attr)
                Object.defineProperty cls.prototype, attr, 
                    get: getter
                    set: setter
                    enumerable: true
            return cls
            
        get_asset_class: (asset_type_name, callback) =>
            v1meta_instance = this
            @server.get_meta_xml {asset_type_name: asset_type_name}, (error, xml) ->
                if error?
                    callback(error)
                cls = @build_asset_class_from_xml(asset_type_name, xml)
                callback(undefined, cls)
                

        
