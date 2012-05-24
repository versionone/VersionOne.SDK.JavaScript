
V1Meta = require('./v1meta').V1Meta
v1 = new V1Meta()

v1.execute () ->
    clas = m.sync_get_asset_class 'Story'
    i = new clas(5)
    console.log clas
    console.log i.Name
    console.log i.Copy()
    
