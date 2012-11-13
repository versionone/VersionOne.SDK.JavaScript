# * base64.js - Base64 encoding and decoding functions
# *
# * See: http://developer.mozilla.org/en/docs/DOM:window.btoa
# *      http://developer.mozilla.org/en/docs/DOM:window.atob
# *
# * Copyright (c) 2007, David Lindquist <david.lindquist@gmail.com>
# * Released under the MIT license
# 

module.exports = 

  btoa: (str) ->
    chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
    encoded = []
    c = 0
    while c < str.length
      b0 = str.charCodeAt(c++)
      b1 = str.charCodeAt(c++)
      b2 = str.charCodeAt(c++)
      buf = (b0 << 16) + ((b1 or 0) << 8) + (b2 or 0)
      i0 = (buf & (63 << 18)) >> 18
      i1 = (buf & (63 << 12)) >> 12
      i2 = (if isNaN(b1) then 64 else (buf & (63 << 6)) >> 6)
      i3 = (if isNaN(b2) then 64 else (buf & 63))
      encoded[encoded.length] = chars.charAt(i0)
      encoded[encoded.length] = chars.charAt(i1)
      encoded[encoded.length] = chars.charAt(i2)
      encoded[encoded.length] = chars.charAt(i3)
    encoded.join ""

  atob: (str) ->
    chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
    invalid =
      strlen: (str.length % 4 isnt 0)
      chars: new RegExp("[^" + chars + "]").test(str)
      equals: (RegExp("=").test(str) and (RegExp("=[^=]").test(str) or RegExp("={3}").test(str)))

    throw new Error("Invalid base64 data")  if invalid.strlen or invalid.chars or invalid.equals
    decoded = []
    c = 0
    while c < str.length
      i0 = chars.indexOf(str.charAt(c++))
      i1 = chars.indexOf(str.charAt(c++))
      i2 = chars.indexOf(str.charAt(c++))
      i3 = chars.indexOf(str.charAt(c++))
      buf = (i0 << 18) + (i1 << 12) + ((i2 & 63) << 6) + (i3 & 63)
      b0 = (buf & (255 << 16)) >> 16
      b1 = (if (i2 is 64) then -1 else (buf & (255 << 8)) >> 8)
      b2 = (if (i3 is 64) then -1 else (buf & 255))
      decoded[decoded.length] = String.fromCharCode(b0)
      decoded[decoded.length] = String.fromCharCode(b1)  if b1 >= 0
      decoded[decoded.length] = String.fromCharCode(b2)  if b2 >= 0
    decoded.join ""

