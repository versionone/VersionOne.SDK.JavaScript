client = require('./client')
server = new client.V1Server()

#console.log(server.build_url('/yo'))

print_errors = (error) -> console.log(error)

print_xml = (xml) -> console.log(xml)


server.get_meta_xml({asset_type_name:'Story'}, console.log, console.log)
server.get_asset_xml({asset_type_name:'Story', id: 1005}, console.log, console.log)




