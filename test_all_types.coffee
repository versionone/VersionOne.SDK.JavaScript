V1Meta = require('./v1meta').V1Meta

v1 = new V1Meta()

v1.for_all_types (err, types) ->
    for type in types
        i = new type('id')
        console.log i
        console.log i._v1_ops

