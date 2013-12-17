/*global define */

define( [
    'require',
    'osgDB/ReaderParser',
    'osg/Utils',
    'osg/Notify',
    'vendors/Q',
    'osg/Image',
    'osg/BufferArray',
    'osg/DrawArrays',
    'osg/DrawArrayLengths',
    'osg/DrawElements',
    'osg/PrimitiveSet'
], function ( require, ReaderParser, MACROUTILS, Notify, Q, Image, BufferArray, DrawArrays, DrawArrayLengths, DrawElements, PrimitiveSet ) {

    var Input = function ( json, identifier ) {
        this._json = json;
        var map = identifier;
        if ( map === undefined ) {
            map = {};
        }
        this._identifierMap = map;
        this._objectRegistry = {};
        this._progressXHRCallback = undefined;
        this._prefixURL = '';
        this.setImageLoadingOptions( {
            promise: true,
            onload: undefined
        } );
    };


    // keep one instance of image fallback
    if ( !Input.imageFallback ) {
        Input.imageFallback = ( function () {
            var fallback = new window.Image();
            fallback.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQIW2P8DwQACgAD/il4QJ8AAAAASUVORK5CYII=';
            return fallback;
        } )();
    }

    Input.prototype = {

        setImageLoadingOptions: function ( options ) {
            this._defaultImageOptions = options;
        },
        getImageLoadingOptions: function () {
            return this._defaultImageOptions;
        },
        setProgressXHRCallback: function ( func ) {
            this._progressXHRCallback = func;
        },

        // used to override the type from pathname
        // typically if you want to create proxy object
        registerObject: function ( fullyqualified_objectname, constructor ) {
            this._objectRegistry[ fullyqualified_objectname ] = constructor;
        },

        getJSON: function () {
            return this._json;
        },

        setJSON: function ( json ) {
            this._json = json;
            return this;
        },

        setPrefixURL: function ( prefix ) {
            this._prefixURL = prefix;
        },
        getPrefixURL: function () {
            return this._prefixURL;
        },
        computeURL: function ( url ) {
            if ( this._prefixURL === undefined ) {
                return url;
            }
            return this._prefixURL + url;
        },
        getObjectWrapper: function ( path ) {
            if ( this._objectRegistry[ path ] !== undefined ) {
                return new( this._objectRegistry[ path ] )();
            }

            // #FIXME to be fixed !
            var scope = window;
            var splittedPath = path.split( '.' );
            for ( var i = 0, l = splittedPath.length; i < l; i++ ) {
                var obj = scope[ splittedPath[ i ] ];
                if ( obj === undefined ) {
                    return undefined;
                }
                scope = obj;
            }
            // create the new obj
            return new( scope )();
        },

        fetchImage: function ( image, url, options, defer ) {
            var checkInlineImage = 'data:image/';
            // crossOrigin does not work for inline data image
            var isInlineImage = ( url.substring( 0, checkInlineImage.length ) === checkInlineImage );
            var img = new window.Image();
            img.onerror = function () {
                Notify.warn( 'warning use white texture as fallback instead of ' + url );
                image.setImage( Input.imageFallback );
                if ( defer ) {
                    defer.resolve( image );
                }
            };

            if ( !isInlineImage && options.crossOrigin ) {
                img.crossOrigin = options.crossOrigin;
            }

            img.onload = function () {

                if ( defer ) {
                    if ( options.onload ) options.onload.call( image );
                    defer.resolve( image );
                } else if ( options.onload )
                    options.onload.call( image );

            };

            image.setURL( url );
            image.setImage( img );

            img.src = url;
            return image;
        },

        readImageURL: function ( url, options ) {
            var self = this;
            // if image is on inline image skip url computation
            if ( url.substr( 0, 10 ) !== 'data:image' ) {
                url = this.computeURL( url );
            }

            if ( options === undefined ) {
                options = this._defaultImageOptions;
            }

            var image = new Image();
            if ( options.promise !== true ) {
                return this.fetchImage( image, url, options );
            }

            defer = Q.defer();
            this.fetchImage( image, url, options, defer );

            return defer.promise;
        },


        readNodeURL: function ( url, options ) {
            url = this.computeURL( url );

            var defer = Q.defer();

            options = options || {};
            var opt = {
                progressXHRCallback: options.progressXHRCallback,
                prefixURL: options.prefixURL,
                defaultImageOptions: options.defaultImageOptions
            };

            // automatic prefix if non specfied
            if ( opt.prefixURL === undefined ) {
                var prefix = this.getPrefixURL();
                var index = url.lastIndexOf( '/' );
                if ( index !== -1 ) {
                    prefix = url.substring( 0, index + 1 );
                }
                opt.prefixURL = prefix;
            }

            var req = new XMLHttpRequest();
            req.open( 'GET', url, true );
            req.onreadystatechange = function ( aEvt ) {
                if ( req.readyState == 4 ) {
                    var child;
                    if ( req.status == 200 ) {
                        var ReaderParser = require( 'osgDB/ReaderParser' );
                        Q.when( ReaderParser.parseSceneGraph( JSON.parse( req.responseText ),
                                opt ),
                            function ( child ) {
                                defer.resolve( child );
                                Notify.log( 'loaded ' + url );

                            } ).fail( function ( error ) {
                            defer.reject( error );
                        } );
                    } else {
                        defer.reject( req.status );
                    }
                }
            };
            req.send( null );
            return defer.promise;
        },

        readBinaryArrayURL: function ( url ) {
            url = this.computeURL( url );

            if ( this._identifierMap[ url ] !== undefined ) {
                return this._identifierMap[ url ];
            }
            var defer = Q.defer();
            var xhr = new XMLHttpRequest();
            xhr.open( 'GET', url, true );
            xhr.responseType = 'arraybuffer';

            if ( this._progressXHRCallback ) {
                xhr.addEventListener( 'progress', this._progressXHRCallback, false );
            }

            xhr.addEventListener( 'error', function () {
                defer.reject();
            }, false );

            var self = this;
            xhr.addEventListener( 'load', function ( oEvent ) {
                var arrayBuffer = xhr.response; // Note: not oReq.responseText
                if ( arrayBuffer ) {
                    // var byteArray = new Uint8Array(arrayBuffer);
                    self._identifierMap[ url ] = arrayBuffer;
                    defer.resolve( arrayBuffer );
                } else {
                    defer.reject();
                }
            }, false );

            xhr.send( null );
            this._identifierMap[ url ] = defer.promise;
            return defer.promise;
        },

        readBufferArray: function () {
            var jsonObj = this.getJSON();

            var uniqueID = jsonObj.UniqueID;
            var osgjsObject;
            if ( uniqueID !== undefined ) {
                osgjsObject = this._identifierMap[ uniqueID ];
                if ( osgjsObject !== undefined ) {
                    return osgjsObject;
                }
            }

            var check = function ( o ) {
                if ( ( o.Elements !== undefined || o.Array !== undefined ) &&
                    o.ItemSize !== undefined &&
                    o.Type ) {
                    return true;
                }
                return false;
            };

            if ( !check( jsonObj ) ) {
                return;
            }

            var obj, defer;

            // inline array
            if ( jsonObj.Elements !== undefined ) {
                obj = new BufferArray( BufferArray[ jsonObj.Type ], jsonObj.Elements, jsonObj.ItemSize );

            } else if ( jsonObj.Array !== undefined ) {

                var buf = new BufferArray( BufferArray[ jsonObj.Type ] );
                buf.setItemSize( jsonObj.ItemSize );

                var vb, type;
                if ( jsonObj.Array.Float32Array !== undefined ) {
                    vb = jsonObj.Array.Float32Array;
                    type = 'Float32Array';
                } else if ( jsonObj.Array.Uint16Array !== undefined ) {
                    vb = jsonObj.Array.Uint16Array;
                    type = 'Uint16Array';
                } else {
                    Notify.warn( 'Typed Array ' + window.Object.keys( o.Array )[ 0 ] );
                    type = 'Float32Array';
                }

                if ( vb !== undefined ) {
                    if ( vb.File !== undefined ) {
                        var url = vb.File;

                        defer = Q.defer();
                        Q.when( this.readBinaryArrayURL( url ) ).then( function ( array ) {

                            var typedArray;
                            // manage endianness
                            var big_endian;
                            ( function () {
                                var a = new Uint8Array( [ 0x12, 0x34 ] );
                                var b = new Uint16Array( a.buffer );
                                big_endian = ( ( b[ 0 ] ).toString( 16 ) === '1234' );
                            } )();

                            var offset = 0;
                            if ( vb.Offset !== undefined ) {
                                offset = vb.Offset;
                            }

                            var bytesPerElement = MACROUTILS[ type ].BYTES_PER_ELEMENT;
                            var nbItems = vb.Size;
                            var nbCoords = buf.getItemSize();
                            var totalSizeInBytes = nbItems * bytesPerElement * nbCoords;

                            if ( big_endian ) {
                                Notify.log( 'big endian detected' );
                                var typed_array = MACROUTILS[ type ];
                                var tmpArray = new typed_array( nbItems * nbCoords );
                                var data = new DataView( array, offset, totalSizeInBytes );
                                var i = 0,
                                    l = tmpArray.length;
                                if ( type === 'Uint16Array' ) {
                                    for ( ; i < l; i++ ) {
                                        tempArray[ i ] = data.getUint16( i * bytesPerElement, true );
                                    }
                                } else if ( type === 'Float32Array' ) {
                                    for ( ; i < l; i++ ) {
                                        tempArray[ i ] = data.getFloat32( i * bytesPerElement, true );
                                    }
                                }
                                typedArray = tempArray;
                                data = null;
                            } else {
                                typedArray = new MACROUTILS[ type ]( array, offset, nbCoords * nbItems );
                            }
                            a = b = null;

                            buf.setElements( typedArray );
                            defer.resolve( buf );
                        } );
                    } else if ( vb.Elements !== undefined ) {
                        var a = new MACROUTILS[ type ]( vb.Elements );
                        buf.setElements( a );
                    }
                }
                obj = buf;
            }

            if ( uniqueID !== undefined ) {
                this._identifierMap[ uniqueID ] = obj;
            }

            if ( defer !== undefined ) {
                return defer.promise;
            }
            return obj;
        },

        readUserDataContainer: function () {
            var jsonObj = this.getJSON();
            var osgjsObject;
            var uniqueID = jsonObj.UniqueID;
            if ( uniqueID !== undefined ) {
                osgjsObject = this._identifierMap[ uniqueID ];
                if ( osgjsObject !== undefined ) {
                    return osgjsObject.Values;
                }
            }

            this._identifierMap[ uniqueID ] = jsonObj;
            return jsonObj.Values;
        },

        readPrimitiveSet: function () {
            var jsonObj = this.getJSON();
            var uniqueID;
            var osgjsObject;

            var obj;
            var defer;
            var drawElementPrimitive = jsonObj.DrawElementUShort || jsonObj.DrawElementUByte || jsonObj.DrawElementUInt || jsonObj.DrawElementsUShort || jsonObj.DrawElementsUByte || jsonObj.DrawElementsUInt || undefined;
            if ( drawElementPrimitive ) {

                uniqueID = drawElementPrimitive.UniqueID;
                if ( uniqueID !== undefined ) {
                    osgjsObject = this._identifierMap[ uniqueID ];
                    if ( osgjsObject !== undefined ) {
                        return osgjsObject;
                    }
                }

                defer = Q.defer();
                var jsonArray = drawElementPrimitive.Indices;
                var prevJson = jsonObj;

                mode = drawElementPrimitive.Mode;
                if ( !mode ) {
                    mode = PrimitiveSet.TRIANGLES;
                } else {
                    mode = PrimitiveSet[ mode ];
                }
                obj = new DrawElements( mode );

                this.setJSON( jsonArray );
                Q.when( this.readBufferArray() ).then(
                    function ( array ) {
                        obj.setIndices( array );
                        defer.resolve( obj );
                    } );
                this.setJSON( prevJson );
            }

            var drawArrayPrimitive = jsonObj.DrawArray || jsonObj.DrawArrays;
            if ( drawArrayPrimitive ) {

                uniqueID = drawArrayPrimitive.UniqueID;
                if ( uniqueID !== undefined ) {
                    osgjsObject = this._identifierMap[ uniqueID ];
                    if ( osgjsObject !== undefined ) {
                        return osgjsObject;
                    }
                }

                mode = drawArrayPrimitive.Mode || drawArrayPrimitive.mode;
                first = drawArrayPrimitive.First !== undefined ? drawArrayPrimitive.First : drawArrayPrimitive.first;
                count = drawArrayPrimitive.Count !== undefined ? drawArrayPrimitive.Count : drawArrayPrimitive.count;
                var drawArray = new DrawArrays( PrimitiveSet[ mode ], first, count );
                obj = drawArray;
            }

            var drawArrayLengthsPrimitive = jsonObj.DrawArrayLengths || undefined;
            if ( drawArrayLengthsPrimitive ) {

                uniqueID = drawArrayLengthsPrimitive.UniqueID;
                if ( uniqueID !== undefined ) {
                    osgjsObject = this._identifierMap[ uniqueID ];
                    if ( osgjsObject !== undefined ) {
                        return osgjsObject;
                    }
                }

                mode = drawArrayLengthsPrimitive.Mode;
                first = drawArrayLengthsPrimitive.First;
                var array = drawArrayLengthsPrimitive.ArrayLengths;
                var drawArrayLengths = new DrawArrayLengths( PrimitiveSet[ mode ], first, array );
                obj = drawArrayLengths;
            }

            if ( uniqueID !== undefined ) {
                this._identifierMap[ uniqueID ] = obj;
            }

            if ( defer ) {
                return defer.promise;
            }
            return obj;
        },


        readObject: function () {

            var jsonObj = this.getJSON();
            var prop = window.Object.keys( jsonObj )[ 0 ];
            if ( !prop ) {
                Notify.warn( 'can\'t find property for object ' + jsonObj );
                return undefined;
            }

            var uniqueID = jsonObj[ prop ].UniqueID;
            var osgjsObject;
            if ( uniqueID !== undefined ) {
                osgjsObject = this._identifierMap[ uniqueID ];
                if ( osgjsObject !== undefined ) {
                    return osgjsObject;
                }
            }

            var obj = this.getObjectWrapper( prop );
            if ( !obj ) {
                Notify.warn( 'can\'t instanciate object ' + prop );
                return undefined;
            }
            var ReaderParser = require( 'osgDB/ReaderParser' );
            var scope = ReaderParser.ObjectWrapper.serializers;
            var splittedPath = prop.split( '.' );
            for ( var i = 0, l = splittedPath.length; i < l; i++ ) {
                var reader = scope[ splittedPath[ i ] ];
                if ( reader === undefined ) {
                    Notify.warn( 'can\'t find function to read object ' + prop + ' - undefined' );
                    return undefined;
                }
                scope = reader;
            }

            var promise = scope( this.setJSON( jsonObj[ prop ] ), obj );

            if ( uniqueID !== undefined ) {
                this._identifierMap[ uniqueID ] = obj;
                obj._uniqueID = uniqueID;
            }
            return promise;
        }
    };

    return Input;
} );