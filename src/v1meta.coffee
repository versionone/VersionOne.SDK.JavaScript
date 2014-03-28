client = require('./client')
et = require('elementtree')
util = require('util')
url = require('url')

asset_dict_filter = (dict) ->
    output = {}
    for k,v of dict
        if v? and (v?.length > 0) and (v!="")
            output[k] = v
    return output

class AssetClassBase
    constructor: (@_v1_id, @_v1_transaction) ->    
        @_v1_new_data = {}
        @_v1_current_data = {}
        return @

    with_data: (data) ->
        @_v1_current_data = data        
        return @

    pending: (data) ->
        @_v1_new_data = data
        return @

    create_in_context: (asste_type, data) ->
        pass
        
    idref: () -> throw "Implement This"

    url: () ->
        v1meta = @_v1_v1meta
        url.format
            protocol: v1meta.server.protocol
            hostname: v1meta.server.hostname
            port: v1meta.server.port
            pathname: v1meta.server.instance + '/assetdetail.v1'
            query: {oid: @_v1_id}
            
    _v1_get: (attr) ->        
        return @_v1_new_data[attr] ? @_v1_current_data[attr]

    _v1_set: (attr, value) ->
        if not @_v1_transaction?
            throw "Properties may only be set on assets having a _v1_transaction"
        @_v1_new_data[attr] = value
        @_v1_transaction.add_to_dirty(@)

    _v1_execute_operation: (opname, callback) =>
        [type, numid] = @_v1_id.split(":")
        options = 
            asset_type_name: @_v1_asset_type_name
            opname: opname
            id: numid
        @_v1_v1meta.server.execute_operation options, callback

    toString: () ->
        current = asset_dict_filter(@_v1_current_data)
        newdata = asset_dict_filter(@_v1_new_data)
        output = "#{@_v1_asset_type_name}('#{@_v1_id}')"
        if Object.keys(current).length > 0
            output = output + ".with_data(\n#{util.inspect current}})"
        if Object.keys(newdata).length > 0
            output = output + "\n.pending(\n#{util.inspect newdata}})"
        return output

class V1Transaction
    constructor: (@query_results=[], @v1meta) ->
        @dirty_assets = []

    add_to_dirty: (asset) ->
        if asset not in @dirty_assets
            @dirty_assets.push asset








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
    V1Transaction: V1Transaction
    V1Meta: class V1Meta
        constructor: (@server) ->
            @global_cache = {}
                    
        for_all_types: (options) ->
            @server.get_meta_xml {asset_type_name: ''}, (err, meta_xml) =>
                return options.error(err) if err?
                meta_xml.iter 'AssetType', (asset_xml) =>
                    options.asset_callback(@build_asset_class_from_xml(asset_xml))
                options.done()
            
        build_asset_class_from_xml: (xml) ->
            asset_type_name = xml.get('name')
            
            v1meta = @

            modelClass = class extends AssetClassBase
                    _v1_asset_type_name: asset_type_name
                    _v1_v1meta: v1meta
                    _v1_ops: []
                    _v1_attrs: []
                    
            xml.iter 'Operation', (operation) ->
                opname = operation.get('name')
                modelClass::_v1_ops.push(opname)
                getter = () ->
                    (callback) =>
                        @_v1_execute_operation(opname, callback)
                Object.defineProperty modelClass.prototype, opname, 
                    get: getter
                    enumerable: true

                    
            xml.iter 'AttributeDefinition', (attribute) =>
                attr = attribute.get('name')
                modelClass::_v1_attrs.push(attr)
                
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

                Object.defineProperty modelClass.prototype, attr, 
                    get: getter
                    set: setter
                    enumerable: true
                    
            return modelClass
            
        build_asset: (AssetClass, assetxml, trans) ->
            oidtoken = assetxml.get('id')
            asset = new AssetClass(oidtoken, trans)
            data = asset._v1_current_data
            for attrxml in assetxml.findall('Attribute')
                attrname = attrxml.get('name')
                data[attrname] = attrxml.text
            for relxml in assetxml.findall('Relation')
                relname = relxml.get('name')
                data[relname] ?= []
                for rel in relxml.findall("Asset")
                    data[relname].push rel.get('idref')
            return asset
        
        query: (options) ->
            if options.from?
                options.asset_type_name = options.from
            @validateOptions options

            @server.get_query_xml options, (err, xmlresults) =>  
                return options.error(err) if err?
                for assetxml in xmlresults.findall('.Asset')
                    oidtoken = assetxml.get('id')
                    [found_type, found_id] = oidtoken.split(':')
                    @get_asset_class found_type, (err, Cls) =>
                        return options.error(err) if err?                
                        asset = @build_asset(Cls, assetxml)
                        options.success(asset)

        trans_query: (options) ->
            if options.from?
                options.asset_type_name = options.from
            @validateOptions options
            @get_asset_class options.asset_type_name, (err, Cls) =>
                return options.error(err) if err?
                @server.get_query_xml options, (err, xmlresults) =>
                    return options.error(err) if err?
                    trans = new V1Transaction([], @)
                    assets = (@build_asset(Cls, asset, trans) for asset in xmlresults.findall('.Asset'))
                    trans.query_results = assets
                    options.success(trans)
                        
        get_asset_class: (asset_type_name, callback) =>
            if asset_type_name of @global_cache
                callback(undefined, @global_cache[asset_type_name])
            else
                @server.get_meta_xml {asset_type_name: asset_type_name}, (error, xml) =>
                    return callback(error) if error?
                    cls = @build_asset_class_from_xml(xml)
                    @global_cache[asset_type_name] = cls
                    callback(undefined, cls)

        validateOptions: (options) ->
            throw "Must pass a 'success' function callback which gets called if data retrieval succeeds" if not options.success?
            throw "Must pass an 'error' function callback which gets called if data retrieval fails" if not options.error?

                
        generate_update_doc: (newdata) ->
            update_doc = new et.Element('Asset')
            for attrname, newvalue of newdata
                do (attrname) =>
                    do (newvalue) =>
                        if newvalue._v1_asset_type_name?
                            node = new et.Element('Relation')
                            node.set('name', attrname)
                            node.set('act', 'set')
                            ra = new et.Element('Asset')
                            ra.set('idref', newvalue.idref())
                            node.append(ra)
                        else  if newvalue instanceof Array
                            node = new et.Element('Relation')
                            node.set('name',attrname)
                            for item in newvalue
                                child = new et.Element('Asset')
                                child.set('idref', item.idref())
                                child.set('act', 'set')
                                node.append(child)
                        else
                            node = new et.Element('Attribute')
                            node.set('name', attrname)
                            node.set('act', 'set')
                            node.text = newvalue.toString()
                        update_doc.append(node)
            return update_doc
        
        create: (asset_type, data, callback) ->
            update_doc = @generate_update_doc(data)
            create_opts =
                asset_type_name: asset_type
                xmldata: update_doc
            @server.create_asset create_opts, (err, result) =>
                return callback(err) if err?
                [created_type, created_id, created_moment] = result.get('id').split(":")
                @query 
                    from: created_type
                    where:
                      ID: "#{created_type}:#{created_id}"
                    select: ['Number', 'Name']
                    error: (err)=>callback(err)
                    success: (result) => 
                        console.log result
                        callback(undefined, result)


                

        
