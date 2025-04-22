module.exports = sails => {
    const Sequelize = require('sequelize');

    // keep a ref to the original sails model loader function
    const originalLoadModels = sails.modules.loadModels;

    return {
        defaults: {
            __configKey__: {
                clsNamespace: 'sails-sequelize',
                exposeToGlobal: true,
                smartMigrate: false,
                dryRun: false
            }
        },
        configure() {
            const cls = sails.config[this.configKey].clsNamespace;
            if (typeof cls === 'string' && cls !== '') {
                Sequelize.useCLS(require('cls-hooked').createNamespace(cls));
            }

            if (sails.config[this.configKey].exposeToGlobal) {
                sails.log.verbose('Exposing Sequelize globally');
                global['Sequelize'] = Sequelize;
            }

            // Override sails internal loadModels function
            sails.modules.loadModels = function load(cb) {
                originalLoadModels((err, modelDefs) => {
                    const models = {};

                    sails.log.verbose('Detecting Waterline models');
                    Object.entries(modelDefs).forEach((entry) => {
                        const [key, model] = entry;

                        if (typeof (model.options) === 'undefined' || typeof (model.options.tableName) === 'undefined') {
                            sails.log.verbose('Loading Waterline model \'' + model.globalId + '\'');
                            models[key] = model;
                        }
                    });

                    cb(err, models);
                });
            };
        },
        initialize(next) {
            if (sails.config.hooks.orm === false) {
                this.initAdapters();
                this.initModels();
                this.reload(next);
            } else {
                sails.on('hook:orm:loaded', () => {
                    this.initAdapters();
                    this.initModels();
                    this.reload(next);
                });
            }
        },

        reload(next) {
            let connections;
            const self = this;

            connections = this.initConnections();

            if (sails.config[this.configKey].exposeToGlobal) {
                sails.log.verbose('Exposing Sequelize connections globally');
                global['SequelizeConnections'] = connections;
            }

            return originalLoadModels((err, models) => {
                if (err) {
                    return next(err);
                }

                self.defineModels(models, connections);
                self.migrateSchema(next, connections, models);
            });
        },

        initAdapters() {
            if (typeof (sails.adapters) === 'undefined') {
                sails.adapters = {};
            }
        },

        initConnections() {
            const connections = {};
            let connection, connectionName;

            // Try to read settings from old Sails then from the new.
            const datastores = sails.config.connections || sails.config.datastores;
            const datastoreName = sails.config.models.connection || sails.config.models.datastore || 'default';

            sails.log.verbose('Using default connection named ' + datastoreName);
            if (!Object.prototype.hasOwnProperty.call(datastores, datastoreName)) {
                throw new Error('Default connection \'' + datastoreName + '\' not found in config/connections');
            }

            for (connectionName in datastores) {
                connection = datastores[connectionName];

                // Skip waterline and possible non sequelize connections
                if (connection.adapter || !(connection.dialect || connection.options.dialect)) {
                    continue;
                }

                if (!connection.options) {
                    connection.options = {};
                }

                // If custom log function is specified, use it for SQL logging or use sails logger of defined level
                if (typeof connection.options.logging === 'string' && connection.options.logging !== '') {
                    connection.options.logging = sails.log[connection.options.logging];
                }

                if (connection.url) {
                    connections[connectionName] = new Sequelize(connection.url, connection.options);
                } else {
                    connections[connectionName] = new Sequelize(connection.database,
                        connection.user,
                        connection.password,
                        connection.options);
                }
            }

            return connections;
        },

        initModels() {
            if (typeof (sails.models) === 'undefined') {
                sails.models = {};
            }
        },

        defineModels(models, connections) {
            let modelDef, modelName, modelClass, cm, im, connectionName;
            const sequelizeMajVersion = parseInt(Sequelize.version.split('.')[0], 10);

            // Try to read settings from old Sails then from the new.
            const defaultConnection = sails.config.models.connection || sails.config.models.datastore || 'default';

            // First pass: define models
            for (modelName in models) {
                modelDef = models[modelName];

                // Skip models without options provided (possible Waterline models)
                if (!modelDef.options) {
                    continue;
                }

                sails.log.verbose('Loading Sequelize model \'' + modelDef.globalId + '\'');
                connectionName = modelDef.connection || modelDef.datastore || defaultConnection;
                modelClass = connections[connectionName].define(modelDef.globalId,
                    modelDef.attributes,
                    modelDef.options);

                if (sequelizeMajVersion >= 4) {
                    for (cm in modelDef.options.classMethods) {
                        modelClass[cm] = modelDef.options.classMethods[cm];
                    }

                    for (im in modelDef.options.instanceMethods) {
                        modelClass.prototype[im] = modelDef.options.instanceMethods[im];
                    }
                }

                if (sails.config.globals.models) {
                    sails.log.verbose('Exposing model \'' + modelDef.globalId + '\' globally');
                    global[modelDef.globalId] = modelClass;
                }
                sails.models[modelDef.globalId.toLowerCase()] = modelClass;
            }

            // Second pass: handle associations and junction tables
            for (modelName in models) {
                modelDef = models[modelName];

                // Skip models without options provided (possible Waterline models)
                if (!modelDef.options) {
                    continue;
                }

                this.setAssociation(modelDef);
                this.setDefaultScope(modelDef, sails.models[modelDef.globalId.toLowerCase()]);
            }

            // Third pass: handle any through model adjustments
            for (modelName in models) {
                modelDef = models[modelName];
                if (!modelDef.options || !modelDef.options.indexes) continue;

                const model = sails.models[modelDef.globalId.toLowerCase()];
                if (!model) continue;

                // Apply non-unique indexes to junction tables if specified
                modelDef.options.indexes.forEach(index => {
                    if (index.unique === false && index.fields && index.fields.length >= 2) {
                        // This will update the model's options but won't affect the DB until migration
                        model._indexes = model._indexes || [];
                        
                        // Check if this index already exists
                        const exists = model._indexes.some(idx => 
                            JSON.stringify(idx.fields) === JSON.stringify(index.fields)
                        );
                        
                        if (!exists) {
                            model._indexes.push(index);
                        }
                    }
                });
            }
        },

        setAssociation(modelDef) {
            if (modelDef.associations !== null) {
                sails.log.verbose('Loading associations for \'' + modelDef.globalId + '\'');
                
                if (typeof modelDef.associations === 'function') {
                    // Capture the original belongsToMany method
                    const originalBelongsToMany = Sequelize.Model.belongsToMany;
                    
                    // Override it temporarily to handle unique constraint options
                    Sequelize.Model.belongsToMany = function(target, options) {
                        // Handle unique constraints for junction tables
                        if (options.through && typeof options.through === 'object') {
                            // If through references a model with non-unique index
                            if (options.through.model) {
                                const throughModelName = options.through.model.name || options.through.model;
                                const throughModelDef = sails.models[throughModelName.toLowerCase()];
                                
                                if (throughModelDef && throughModelDef.options && throughModelDef.options.indexes) {
                                    const hasNonUniqueIndex = throughModelDef.options.indexes.some(idx => 
                                        idx.unique === false && 
                                        idx.fields && 
                                        idx.fields.length === 2
                                    );
                                    
                                    if (hasNonUniqueIndex) {
                                        options.uniqueKey = false;
                                    }
                                }
                            }
                            
                            // If through is specified with unique: false
                            if (options.through.unique === false) {
                                options.uniqueKey = false;
                            }
                        }
                        
                        return originalBelongsToMany.call(this, target, options);
                    };
                    
                    // Call the associations function
                    modelDef.associations(modelDef);
                    
                    // Restore the original method
                    Sequelize.Model.belongsToMany = originalBelongsToMany;
                }
            }
        },

        setDefaultScope(modelDef, model) {
            if (modelDef.defaultScope !== null) {
                sails.log.verbose('Loading default scope for \'' + modelDef.globalId + '\'');
                if (typeof modelDef.defaultScope === 'function') {
                    const defaultScope = modelDef.defaultScope() || {};
                    model.addScope('defaultScope', defaultScope, { override: true });
                }
            }
        },

        async deduplicateIndexes(connection, tableName, dialect) {
            let existingIndexes = [];
            try {
                if (dialect === 'postgres') {
                    const result = await connection.query(
                        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '${tableName.toLowerCase()}'`,
                        { type: Sequelize.QueryTypes.SELECT }
                    );
                    existingIndexes = result.map(idx => ({
                        name: idx.indexname,
                        definition: idx.indexdef
                    }));
                } else if (dialect === 'mysql') {
                    const result = await connection.query(
                        `SHOW INDEX FROM ${tableName}`,
                        { type: Sequelize.QueryTypes.SELECT }
                    );
                    existingIndexes = result.map(idx => ({
                        name: idx.Key_name,
                        columns: idx.Column_name,
                        unique: idx.Non_unique === 0
                    }));
                }
            } catch (err) {
                // Table might not exist yet
                return [];
            }
            
            return existingIndexes;
        },

        migrateSchema(next, connections, models) {
            let connectionDescription, cn, migrate, forceSyncFlag, alterFlag;
            const syncTasks = [];

            // Try to read settings from old Sails then from the new.
            const datastores = sails.config.connections || sails.config.datastores;

            migrate = sails.config.models.migrate;
            sails.log.verbose('Models migration strategy: ' + migrate);

            if (migrate === 'safe') {
                return next();
            } else {
                switch (migrate) {
                    case 'drop':
                        forceSyncFlag = true;
                        alterFlag = false;
                        break;
                    case 'alter':
                        forceSyncFlag = false;
                        alterFlag = true;
                        break;
                    default:
                        forceSyncFlag = false;
                        alterFlag = false;
                }

                const smartMigrate = sails.config[this.configKey].smartMigrate;
                const dryRun = sails.config[this.configKey].dryRun;

                for (cn in datastores) {
                    (function (connectionName) {
                        var syncConnectionName = connectionName;
                        connectionDescription = datastores[syncConnectionName];

                        // Skip waterline and possible non sequelize connections
                        if (connectionDescription.adapter ||
                            !(connectionDescription.dialect || connectionDescription.options.dialect)) {
                            return;
                        }

                        sails.log.verbose('Migrating schema in \'' + connectionName + '\' connection');

                        const dialect = connectionDescription.dialect || connectionDescription.options.dialect;

                        if (dryRun) {
                            sails.log.info(`DRY RUN - Would sync database with force=${forceSyncFlag}, alter=${alterFlag}`);
                            return;
                        }

                        if (smartMigrate && alterFlag) {
                            // Smart migration strategy for alter mode
                            syncTasks.push(async () => {
                                const connection = connections[syncConnectionName];
                                const queryInterface = connection.getQueryInterface();
                                
                                for (const modelName in models) {
                                    const modelDef = models[modelName];
                                    if (!modelDef.options) continue;
                                    
                                    const model = sails.models[modelDef.globalId.toLowerCase()];
                                    if (!model) continue;
                                    
                                    // Deduplicate indexes before applying changes
                                    const tableName = model.getTableName();
                                    const existingIndexes = await this.deduplicateIndexes(
                                        connection, 
                                        tableName,
                                        dialect
                                    );
                                    
                                    // Filter out indexes that already exist
                                    if (model._indexes && model._indexes.length) {
                                        const newIndexes = [];
                                        
                                        for (const idx of model._indexes) {
                                            const indexName = idx.name || `${tableName}_${idx.fields.join('_')}`;
                                            const exists = existingIndexes.some(existing => 
                                                existing.name === indexName
                                            );
                                            
                                            if (!exists) {
                                                newIndexes.push(idx);
                                            }
                                        }
                                        
                                        // Only set new indexes if there are any
                                        if (newIndexes.length > 0) {
                                            model._indexes = newIndexes;
                                        } else {
                                            model._indexes = [];
                                        }
                                    }
                                }
                                
                                return connection.sync({ force: forceSyncFlag, alter: alterFlag });
                            });
                        } else if (dialect === 'postgres') {
                            syncTasks.push(connections[syncConnectionName].showAllSchemas().then(schemas => {
                                let modelName, modelDef, tableSchema;

                                for (modelName in models) {
                                    modelDef = models[modelName];
                                    tableSchema = modelDef.options.schema || '';

                                    if (tableSchema !== '' && schemas.indexOf(tableSchema) < 0) {
                                        connections[syncConnectionName].createSchema(tableSchema);
                                        schemas.push(tableSchema);
                                    }
                                }
                                return connections[syncConnectionName].sync({ force: forceSyncFlag, alter: alterFlag });
                            }));
                        } else {
                            syncTasks.push(connections[syncConnectionName].sync({
                                force: forceSyncFlag,
                                alter: alterFlag
                            }));
                        }
                    }.bind(this))(cn);
                }

                if (dryRun) {
                    sails.log.info('DRY RUN completed - no changes made to database');
                    return next();
                }

                Promise.all(syncTasks)
                    .then(() => {
                        sails.log.info('Database migration completed successfully');
                        next();
                    })
                    .catch(e => {
                        sails.log.error('Database migration failed:', e.message);
                        if (e.name === 'SequelizeDatabaseError' && e.parent) {
                            sails.log.error('Database error details:', e.parent.message);
                        }
                        next(e);
                    });
            }
        }
    };
};