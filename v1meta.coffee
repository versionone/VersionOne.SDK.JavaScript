

client = require('./client')
et = require('elementtree')

future = require('fibers/future')
wait = future.wait

class V1AdvancedQuery
    constructor: (@asset) ->
    query:  (options) ->
        @opt_select = options.select
        @opt_where = options.where
    iter: (callback) ->
        throw 'NotImplemented'


class V1Query
    constructor: (@asset) ->
        @select_list = []
        @where_terms = {}
        
    select: (namelist) ->
        @select_list.extend(namelist)
        
    where: (terms) ->
        for k,v of terms
            @where_terms[k] = v 
            
    iter: (callback) ->
        throw 'NotImplemented'

class AssetClassBase
    constructor: () ->
        @_v1_new_data = {}
        @_v1_current_data = {}
        @_v1_needs_refresh = true
    query: (options) ->
        return new V1AdvancedQuery(@).query(options)
    where: (options) ->
        return new V1Query(@).where(options)
    select: () ->
        return new V1Query(@).select(arguments)
    with_data: (data) ->
        @_v1_current_data = data
        return @
    pending: (data) ->
        @_v1_new_data = data
        return @
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
        
module.exports = 
    V1Meta: class V1Meta
        constructor: (address='localhost', instance='VersionOne.Web', username='admin', password='admin') ->
            @server = new client.V1Server(address, instance, username, password)
            @global_cache = {}
            @dirtylist = []
            
        execute:  (user_func) ->
            runner = () ->
                user_func(@)
            return Fiber(runner).run()
                    
        get_asset_class: (asset_type_name, callback) =>
            v1meta_instance = this
            @server.get_meta_xml {asset_type_name: asset_type_name}, (error, xml) ->
                if error?
                    callback(error)
                cls = class extends AssetClassBase
                    _v1_asset_type_name: asset_type_name
                    _v1_v1meta = v1meta_instance
                    constructor: (@id) ->
                        
                xml.iter 'Operation', (operation) ->
                    opname = operation.get('name')
                    console.log opname
                    cls.prototype[opname] = () ->
                        @_v1_execute_operation(opname)
                
                xml.iter 'AttributeDefinition', (attribute) ->
                    attr = attribute.get('name')
                    if attribute.get('attributetype') == 'Relation'
                        setter = (value) ->
                            @_v1_set(attr, value)
                        getter = () ->
                            @_v1_get(attr)
                    if attribute.get('ismultivalue') != 'True'
                        setter = (value) -> 
                            @_v1_set(attr, value)
                        getter = () ->
                            @_v1_get(attr)
                    Object.defineProperty cls.prototype, attr, 
                        get: getter
                        set: setter
                        enumerable: true
                        
                callback(undefined, cls)
                
        sync_get_asset_class: (asset_type_name) ->
            getit = future.wrap(@get_asset_class)
            return getit(asset_type_name).wait()
            
        asset_from_oid: (oidtoken) ->
            sync_get_asset_class = future.wrap(@get_asset_class)
            [asset_type, id] = oidtoken.split(':', 2)
            AssetClass = sync_get_asset_class(asset_type).wait()
            return new AssetClass(id)
        
