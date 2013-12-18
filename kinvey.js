(function() {
    'use strict';

    angular
        .module('kinvey', ['ngResource', 'ngCookies', 'base64'])

        .provider('$kinvey', ['$base64', function($base64) {

            var apiVersion = 3;
            var appKey;

            /*
                URL BUILDING STRINGS
             */
            var baseUrl = 'https://baas.kinvey.com/';
            var appdata = 'appdata/';
            var userdata = 'user/';
            var groupdata = 'group/';
            var rpcdata = 'rpc/';
            var customdata = 'custom/';
            var blobdata = 'blob/';

            /*
                THESE LIVE HEADER OBJECTS ARE USED FOR ALL REQUESTS TO KINVEY
             */
            var headers = {
                user: {
                    'X-Kinvey-API-Version': apiVersion,
                    'Authorization': ''
                },
                basic: {
                    'X-Kinvey-API-Version': apiVersion,
                    'Authorization': ''
                }
            };

            return {

                init: function(options) {
                    if(!options || !options.appKey || !options.appSecret) {
                        throw '$kinveyProvider.init requires an options object: {\'appId\':\'YOUR APP ID\',\'appSecret\':\'YOUR APP SECRET\'}';
                    }
                    appKey = options.appKey;
                    headers.user.Authorization = headers.basic.Authorization = 'Basic '+$base64.encode(options.appKey+':'+options.appSecret);
                },

                $get: ['$cookieStore', '$resource', '$http', '$q', function($cookieStore, $resource, $http, $q) {

                    /*
                        RETRIEVE THE LAST SESSION FROM COOKIES
                     */
                    var oldToken = $cookieStore.get(appKey+':authToken');
                    if(oldToken) {
                        headers.user.Authorization = oldToken;
                    }

                    /*
                        CUSTOM HTTP TARGETS NOT GENERATED BY THE $resource DECLARATIONS
                     */
                    var funcDefs = {
                        handshake: function() {
                            return {
                                method: 'GET',
                                url: baseUrl + appdata + appKey,
                                headers: headers.basic
                            };
                        },
                        rpc: function(endpoint, data) {
                            return {
                                method: 'POST',
                                url: baseUrl + rpcdata + appKey + '/' + customdata + endpoint,
                                headers: headers.user,
                                data: data
                            };
                        },
                        upload: function(file, filedata, mimeType) {
                            return {
                                method: 'PUT',
                                url: file._uploadURL,
                                file: filedata,
                                headers: angular.extend({
                                    'Content-Type': mimeType,
                                    'Accept': undefined
                                }, file._requiredHeaders),
                                transformRequest: angular.identity
                            };
                        },
                        download: function(file) {
                            return {
                                method: 'GET',
                                url: file._downloadURL
                            };
                        },
                        saveFile: function(file, mimeType) {
                            return {
                                method: file._id ? 'PUT' : 'POST',
                                url: baseUrl + blobdata + appKey + (file._id ? '/'+file._id : ''),
                                headers: angular.extend({
                                    'X-Kinvey-Content-Type': mimeType
                                }, headers.user),
                                data: file
                            };
                        }
                    };

                    /*
                     CUSTOM SERIALIZATION METHODS

                     Since AngularJS strips the `$` namespace out from objects when it serializes them we
                     need to customize this behaviour to preserve mongo operators in queries
                     */

                    function isWindow(obj) {
                        return obj && obj.document && obj.location && obj.alert && obj.setInterval;
                    }

                    function isScope(obj) {
                        return obj && obj.$evalAsync && obj.$watch;
                    }

                    function toJsonReplacer(key, value) {
                        var val = value;

                        if (typeof key === 'string' && key.charAt(0) === '$') {
                            var isMongo = false;
                            angular.forEach(mongoOperators, function(op) {
                                if(op == key) {
                                    isMongo = true;
                                }
                            });
                            if(!isMongo) {
                                val = undefined;
                            }
                        } else if (isWindow(value)) {
                            val = '$WINDOW';
                        } else if (value &&  document === value) {
                            val = '$DOCUMENT';
                        } else if (isScope(value)) {
                            val = '$SCOPE';
                        }

                        return val;
                    }

                    function toJson(obj, pretty) {
                        if (typeof obj === 'undefined') return undefined;
                        return JSON.stringify(obj, toJsonReplacer, pretty ? '  ' : null);
                    }

                    /*
                     STRINGS FOR MONGO COMPATABILITY
                     */
                    var mongoOperators = [
                        "$gt", "$gte", "$in", "$lt", "$lte", "$ne", "$nin", // comparison
                        "$or", "$and", "$not", "$nor", // logical
                        "$exists", "$type", // element
                        "$mod", "$regex", "$where", //evaluation
                        "$geoWithin", "$geoIntersects", "$near", "$nearSphere", //geospatial
                        "$all", "$elemMatch", "$size", // array
                        "$", "$elemMatch", "$slice" // projection
                    ];
                    var mongoMethods = ['query', 'delete'];

                    /*
                        THESE METHODS PROVIDE WAYS TO AUGMENT WORKFLOW WITH COMMON ADDITIONS
                     */

                    // decorates an acting promise function with a `$resource` style response structure
                    function augmentPromise(actor, orig) {
                        var deferred = $q.defer();
                        var retVal = orig || { };

                        if(!('$resolved' in retVal)) {
                            retVal.$resolved = false;
                        }
                        retVal.$promise = deferred.promise;

                        actor(retVal, deferred);

                        return retVal;
                    }

                    // provides a resolving function that manipulates a `$resource` style response structure
                    function augmentResolve(returningObj, deferred, transformResponse) {
                        return function(response) {
                            var publicResponse = transformResponse ? transformResponse(response) : response;
                            angular.extend(returningObj, publicResponse);
                            returningObj.$resolved = true;
                            deferred.resolve(publicResponse);
                        };
                    }

                    // provides a rejecting function that manipulates a `$resource` style response structure
                    function augmentReject(deferred, transformResponse) {
                        return function(response) {
                            var publicResponse = transformResponse ? transformResponse(response) : response;
                            deferred.reject(publicResponse);
                        };
                    }

                    // provides special serialization for methods that require mongo-friendly serialization
                    function augmentForMongo(resourceDef) {
                        angular.forEach(mongoMethods, function(method) {
                            var origMethod = resourceDef[method];
                            resourceDef[method] = function(a1, a2, a3, a4) {
                                if(a1 && 'query' in a1) {
                                    a1.query = JSON.stringify(a1.query);
                                }
                                return origMethod(a1, a2, a3, a4);
                            };
                        });
                        var origGroup = resourceDef.group;
                        resourceDef.group = function(a1, a2, a3) {
                            if(a1.reduce) {
                                a1.reduce = a1.reduce.toString();
                                a1.reduce = a1.reduce.replace(/\n/g,'');
                                a1.reduce = a1.reduce.replace(/\s/g,'');
                            }
                            return origGroup(undefined, a1, a2, a3);
                        };
                        return resourceDef;
                    }

                    // augments the File `$resource` definition with extra, promise based methods
                    function augmentFileDef(resourceDef) {

                        resourceDef.prototype.$download = function() {
                            var file = this;
                            return augmentPromise(function(retVal, deferred) {
                                $http(funcDefs.download(file))
                                    .then(
                                        augmentResolve(retVal, deferred, getData),
                                        augmentReject(deferred, getData));
                            });
                        };
                        resourceDef.prototype.$upload = function(filedata, mimeType) {
                            var file = this;
                            return augmentPromise(function(retVal, deferred) {
                                $http(funcDefs.upload(file, filedata, mimeType))
                                    .then(
                                        augmentResolve(retVal, deferred, getData),
                                        augmentReject(deferred, getData));
                            });
                        };
                        resourceDef.prototype.$save = function(mimeType) {
                            var file = this;
                            return augmentPromise(function(retVal, deferred) {
                                $http(funcDefs.saveFile(file, mimeType))
                                    .then(
                                        augmentResolve(retVal, deferred, getFile),
                                        augmentReject(deferred, getData));
                            }, file);
                        };

                        resourceDef.upload = function(file, filedata, mimeType) {
                            return augmentPromise(function(retVal, deferred) {
                                $http(funcDefs.upload(file, filedata, mimeType))
                                    .then(
                                        augmentResolve(retVal, deferred, getData),
                                        augmentReject(deferred, getData));
                            });
                        };
                        resourceDef.download = function(file) {
                            return augmentPromise(function(retVal, deferred) {
                                $http(funcDefs.download(file))
                                    .then(
                                        augmentResolve(retVal, deferred, getData),
                                        augmentReject(deferred, getData));
                            });
                        };
                        resourceDef.save = function(file, mimeType) {
                            return augmentPromise(function(retVal, deferred) {
                                $http(funcDefs.saveFile(file, mimeType))
                                    .then(
                                        augmentResolve(retVal, deferred, getFile),
                                        augmentReject(deferred, getData));
                            }, file);
                        };

                        return resourceDef;
                    }

                    // augments the Object `$resource` definition
                    function augmentObjectDef(className, resourceDef) {

                        resourceDef.save = function(obj) {
                            if(obj._id) {
                                return Object(className).update(obj);
                            } else {
                                return Object(className).create(obj);
                            }
                        };

                        resourceDef.prototype.$save = function(args) {
                            if(args && args._id && !this._id) {
                                this._id = args._id;
                            }
                            if(this._id) {
                                return this.$update(args);
                            } else {
                                return this.$create(args);
                            }
                        };

                        return resourceDef;
                    }

                    // gets the data component of a `$http` response object
                    function getData(response) {
                        return response.data;
                    }

                    // gets a File from a `$http` repsonse object
                    function getFile(response) {
                        return new File(getData(response));
                    }

                    /*
                        THESE METHODS PERFORM SIMPLE 'ROUNDTRIP' OPERATIONS
                     */

                    // performs a simple handshake
                    function handshake() {
                        return augmentPromise(function(retVal, deferred) {
                            $http(funcDefs.handshake())
                                .then(
                                    augmentResolve(retVal, deferred, getData),
                                    augmentReject(deferred, getData));
                        });
                    }

                    // performs an rpc call
                    function rpc(endpoint, data) {
                        return augmentPromise(function(retVal, deferred) {
                            $http(funcDefs.rpc(endpoint, data))
                                .then(
                                    augmentResolve(retVal, deferred, getData),
                                    augmentReject(deferred, getData));
                        });
                    }

                    /*
                        HERE BE `$resource` DEFINITIONS AND FACTORIES
                     */

                    // Object `$resource` definition factory
                    var Object = function(className) {
                        return augmentObjectDef(className,
                            augmentForMongo(
                                $resource(baseUrl + appdata + appKey + '/' + className + '/:_id', {_id: '@_id'}, {
                                    create: {
                                        method: 'POST',
                                        transformResponse: function(data) {
                                            return new (Object(className))(angular.fromJson(data));
                                        },
                                        headers: headers.user,
                                        params: {
                                            _id: ''
                                        }
                                    },
                                    get: {
                                        method: 'GET',
                                        transformResponse: function(data) {
                                            return new (Object(className))(angular.fromJson(data));
                                        },
                                        headers: headers.user
                                    },
                                    count: {
                                        method: 'GET',
                                        headers: headers.user,
                                        params: {
                                            _id: '_count'
                                        }
                                    },
                                    update: {
                                        method: 'PUT',
                                        transformResponse: function(data) {
                                            return new (Object(className))(angular.fromJson(data));
                                        },
                                        headers: headers.user
                                    },
                                    delete: {
                                        method: 'DELETE',
                                        headers: headers.user
                                    },
                                    query: {
                                        method: 'GET',
                                        transformResponse: function(data) {
                                            var retVal = [];
                                            var objs = angular.fromJson(data);
                                            angular.forEach(objs, function(obj) {
                                                retVal.push(new (Object(className))(obj));
                                            });
                                            return retVal;
                                        },
                                        headers: headers.user,
                                        isArray: true,
                                        params: {
                                            _id: ''
                                        }
                                    },
                                    group: {
                                        method: 'POST',
                                        headers: headers.user,
                                        isArray: true,
                                        params: {
                                            _id: '_group'
                                        },
                                        transformRequest: function(data) {
                                            return toJson(data);
                                        }
                                    }
                                })));
                    };

                    // User `$resource` definition
                    var User =
                        augmentForMongo(
                            $resource(baseUrl + userdata + appKey + '/:_id', {_id: '@_id'} ,{
                                login: {
                                    method: 'POST',
                                    params: {
                                        _id: 'login'
                                    },
                                    transformResponse: function(data) {
                                        data = angular.fromJson(data);
                                        if(!data.error) {
                                            headers.user.Authorization = 'Kinvey '+data._kmd.authtoken;
                                            $cookieStore.put(appKey+':authToken', 'Kinvey '+data._kmd.authtoken);
                                        }
                                        return new User(data);
                                    },
                                    headers: headers.user
                                },
                                current: {
                                    method: 'GET',
                                    params: {
                                        _id: '_me'
                                    },
                                    transformResponse: function(data) {
                                        return new User(angular.fromJson(data));
                                    },
                                    headers: headers.user
                                },
                                logout: {
                                    method: 'POST',
                                    params: {
                                        _id: '_logout'
                                    },
                                    transformResponse: function() {
                                        headers.user.Authorization = headers.basic.Authorization;
                                        $cookieStore.remove(appKey+':authToken');
                                    },
                                    headers: headers.user
                                },
                                signup: {
                                    method: 'POST',
                                    headers: headers.basic,
                                    transformResponse: function(data) {

                                        data = angular.fromJson(data);
                                        if(!data.error) {
                                            headers.user.Authorization = 'Kinvey '+data._kmd.authtoken;
                                            $cookieStore.put(appKey+':authToken', 'Kinvey '+data._kmd.authtoken);
                                        }
                                        return new User(data);
                                    }
                                },
                                get: {
                                    method: 'GET',
                                    transformResponse: function(data) {
                                        return new User(angular.fromJson(data));
                                    },
                                    headers: headers.user
                                },
                                lookup: {
                                    method: 'POST',
                                    transformResponse: function(data) {
                                        var retVal = [];
                                        data = angular.fromJson(data);
                                        angular.forEach(data, function(user) {
                                            retVal.push(new User(user));
                                        });
                                        return retVal;
                                    },
                                    headers: headers.user,
                                    isArray:true,
                                    params: {
                                        _id: '_lookup'
                                    }
                                },
                                save:   {
                                    method:'PUT',
                                    transformResponse: function(data) {
                                        return new User(angular.fromJson(data));
                                    },
                                    headers: headers.user
                                },
                                query:  {
                                    url: baseUrl + userdata + appKey + '/?query=:query',
                                    method:'GET',
                                    transformResponse: function(data) {
                                        var retVal = [];
                                        data = angular.fromJson(data);
                                        angular.forEach(data, function(user) {
                                            retVal.push(new User(user));
                                        });
                                        return retVal;
                                    },
                                    headers: headers.user,
                                    isArray:true,
                                    params: {}
                                },
                                delete: {
                                    method:'DELETE',
                                    params: {
                                        hard: true
                                    },
                                    headers: headers.user
                                },
                                suspend: {
                                    method:'DELETE',
                                    headers: headers.user
                                },
                                verifyEmail: {
                                    method: 'POST',
                                    headers: {
                                        Authorization: headers.user.Authorization,
                                        'X-Kinvey-API-Version': headers.user['X-Kinvey-API-Version'],
                                        'Content-Type': undefined
                                    },
                                    url: baseUrl+rpcdata+appKey+'/:username:email/user-email-verification-initiate',
                                    params: {
                                        username: '@username',
                                        email: '@email'
                                    },
                                    transformRequest: function() {
                                        return '';
                                    }
                                },
                                resetPassword: {
                                    method: 'POST',
                                    headers: headers.basic,
                                    url: baseUrl+rpcdata+appKey+'/:username:email/user-password-reset-initiate',
                                    params: {
                                        username: '@username',
                                        email: '@email'
                                    },
                                    transformRequest: function() {
                                        return '';
                                    }
                                },
                                checkUsernameExists: {
                                    method: 'POST',
                                    headers: headers.basic,
                                    url: baseUrl+rpcdata+appKey+'/check-username-exists'
                                }
                            }));

                    // Group `$resource` definition
                    var Group =
                            $resource(baseUrl + groupdata + appKey + '/:_id', {_id: '@_id'}, {
                        get: {
                            method: 'GET',
                            headers: headers.user
                        },
                        save: {
                            method: 'PUT',
                            headers: headers.user
                        },
                        delete: {
                            method: 'DELETE',
                            headers: headers.user
                        }
                    });

                    // File `$resource` definition
                    var File =
                        augmentFileDef(
                            augmentForMongo(
                                $resource(baseUrl + blobdata + appKey + '/:_id', {_id: '@_id'}, {
                        get: {
                            method: 'GET',
                            headers: headers.user,
                            transformResponse: function(data) {
                                return new File(angular.fromJson(data));
                            }
                        },
                        query:  {
                            method:'GET',
                            headers: headers.user,
                            isArray:true,
                            params: {
                                _id: ''
                            },
                            transformResponse: function(data) {
                                var retVal = [];
                                angular.forEach(angular.fromJson(data), function(obj) {
                                    retVal.push(new File(obj));
                                });
                                return retVal;
                            }
                        },
                        delete: {
                            method:'DELETE',
                            headers: headers.user
                        }
                    })));

                    /*
                        THESE METHODS ALLOW ALIASES FOR OBJECT DEFINITIONS TO BE CREATED
                     */

                    // verify that a critical method is not being overridden
                    function verifyAlias(alias, protectedName) {
                        if(alias === protectedName) {
                            throw 'aliases must not attempt to overwrite $kinvey.'+protectedName;
                        }
                    }

                    // set up an alias
                    function alias(classname, aliasname) {
                        verifyAlias(aliasname, 'handshake');
                        verifyAlias(aliasname, 'User');
                        verifyAlias(aliasname, 'Group');
                        verifyAlias(aliasname, 'Object');
                        verifyAlias(aliasname, 'alias');

                        api[aliasname] = Object(classname);
                    }

                    /*
                        THIS STATEMENT RETURNS THE PUBLIC API
                     */

                    var api = {
                        handshake: handshake,
                        User: User,
                        Group: Group,
                        Object: Object,
                        File: File,
                        alias: alias,
                        rpc: rpc
                    };
                    return api;
                }]
            };
    }]);
})();