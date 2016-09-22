/**
 * @file Responsible for locally indexing Salesforce metadata (Custom Objects, Apex Classes, Lightning files, etc.)
 * @author Joseph Ferraro <@joeferraro>
 */

'use strict';
var _               = require('lodash');
var Promise         = require('bluebird');
var temp            = require('temp');
var config          = require('../../config');
var path            = require('path');
var util            = require('../util');
var find            = require('findit');
var logger          = require('winston');
var parseXml        = require('xml2js').parseString;
var MetadataHelper  = require('../metadata').MetadataHelper;
var Package         = require('../package');
var MavensMateFile  = require('../file').MavensMateFile;
var helper          = require('./helper');

/**
 * Service to get an index of an org's metadata
 * @param {Object} project - project instance (optional)
 * @param {Object} sfdcClient - client instance (optional)
 */
function Indexer(sfdcClient, subscription) {
  this.sfdcClient = sfdcClient;
  this.subscription = subscription;
}

/**
 * Indexes Salesforce.com org (writes to .org_metadata) based on project subscription
 * @return {Promise}
 */
Indexer.prototype.index = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    logger.debug('indexing subscription: ');
    logger.debug(self.subscription);

    var typeMap = {};

    var listRequests = [];

    _.each(self.subscription, function(subscriptionXmlName) {
      logger.debug('adding type to map ', subscriptionXmlName);

      // todo: convenience method
      var mType = _.find(self.sfdcClient.describe.metadataObjects, function(d) {
        return subscriptionXmlName === d.xmlName;
      });

      logger.debug(mType);

      if (!mType) {
        throw new Error('Unknown metadata type: '+subscriptionXmlName);
      }

      typeMap[subscriptionXmlName] = mType;

      var typeRequestName; // name to submit to list query
      // prepare folder-based metadata for query
      var isFolderMetadata = typeMap[subscriptionXmlName].inFolder;
      if (isFolderMetadata) {
        typeRequestName = self._transformFolderNameForListRequest(subscriptionXmlName);
      } else {
        typeRequestName = subscriptionXmlName;
      }

      logger.debug(typeRequestName);

      // TODO: reimplement list providers
      // if (_.has(pkg, subscriptionXmlName+'ListProvider')) {
      //   var listProvider = new pkg[subscriptionXmlName+'ListProvider'](self.sfdcClient);
      //   listRequests.push(listProvider.getList());
      // } else {
      //   listRequests.push(self.sfdcClient.list(typeRequestName));
      // }
      listRequests.push(self.sfdcClient.list(typeRequestName));
    });

    logger.debug(listRequests);

    Promise.all(listRequests)
      .then(function(results) {
        var typePromises = [];
        _.each(results, function(metadataListResult) {
          logger.debug('indexing type promise: ');
          logger.debug(metadataListResult);
          logger.debug(JSON.stringify(typeMap));
          typePromises.push(self._indexType(metadataListResult, typeMap));
        });
        return Promise.all(typePromises);
      })
      .then(function(results) {
        resolve(results);
      })
      .catch(function(error) {
        logger.error('An error occurred indexing server properties');
        logger.error(error.message);
        logger.error(error.stack);
        reject(error);
      });
    });
};

Indexer.prototype.setChecked = function(src, ids, dpth, key) {
  // Recursively find checked item
  var self = this;

  if (!key) key = '';
  if (!ids) ids = [];
  if (!dpth) dpth = 0;

  if (_.isArray(src)) {
    _.each(src, function(litem) {
      if (_.isObject(litem)) {
        if (_.has(litem, 'id') && ids.indexOf(litem.id) >= 0) {
          litem.checked = true;
          litem.select = true;
        }
      }
      self.setChecked(litem, ids, dpth + 2);
    });
  } else if (_.isObject(src)) {
    _.forOwn(src, function(value, key) {
      self.setChecked(value, ids, dpth + 1, key);
    });
  }
};

Indexer.prototype.setVisibility = function(jsonData, query) {
  this._crawl(jsonData, 0, query.toLowerCase(), 0);
};

Indexer.prototype.ensureParentsAreCheckedIfNecessary = function(orgMetadata) {
  _.each(orgMetadata, function(metadataType) {
    if (metadataType.children && _.isArray(metadataType.children)) {
      var numberOfChildrenSelected = 0;
      _.each(metadataType.children, function(c) {
        if (c.select) {
          numberOfChildrenSelected++;
        }
      });
      if (metadataType.children.length === numberOfChildrenSelected && metadataType.children > 0) {
        metadataType.checked = true;
        metadataType.select = true;
      }
    }
  });
};

// Indexer.prototype.getIndexWithLocalSubscription = function() {
//   var promise;
//   var customPackage;
//   if (packageXmlPath) {
//     customPackage = new Package({ path: packageXmlPath });
//     promise = customPackage.init();
//   } else {
//     promise = Promise.resolve();
//   }

//   promise
//     .then(function() {
//       if (!ids) {
//         ids = [];
//         var pkg = packageXmlPath ? customPackage : self.packageXml;
//         _.forOwn(pkg.subscription, function(packageMembers, metadataTypeXmlName) {
//           var metadataType = self.metadataHelper.getTypeByXmlName(metadataTypeXmlName); //inFolder, childXmlNames
//           if (!metadataType) {
//             return reject(new Error('Unrecognized package.xml metadata type: '+metadataTypeXmlName));
//           }
//           if (_.has(metadataType, 'parentXmlName')) {
//             var parentMetadataType = self.metadataHelper.getTypeByXmlName(metadataType.parentXmlName);
//           }
//           if (packageMembers === '*') {
//             ids.push(metadataTypeXmlName);
//             var indexedType = _.find(orgMetadata, { 'xmlName': metadataTypeXmlName });
//             if (_.has(indexedType, 'children')) {
//               _.each(indexedType.children, function(child) {
//                 child.select = true;
//               });
//             }
//           } else {
//             _.each(packageMembers, function(member) {
//               if (metadataType.inFolder) {
//                 // id : Document.FolderName.FileName.txt
//                 ids.push([metadataTypeXmlName, member.replace(/\//, '.')].join('.'));
//               } else if (parentMetadataType) {
//                 // id : CustomObject.Object_Name__c.fields.Field_Name__c
//                 var id = [ parentMetadataType.xmlName, member.split('.')[0], metadataType.tagName, member.split('.')[1] ].join('.');
//                 ids.push(id);
//               } else if (_.has(metadataType, 'childXmlNames')) {
//                 var indexedType = _.find(orgMetadata, { 'xmlName': metadataTypeXmlName });
//                 if (indexedType) {
//                   var indexedNode = _.find(indexedType.children, { 'id': [metadataTypeXmlName, member].join('.')});
//                   if (_.has(indexedNode, 'children')) {
//                     _.each(indexedNode.children, function(child) {
//                       child.select = true;
//                       if (_.has(child, 'children')) {
//                         _.each(child.children, function(grandChild) {
//                           grandChild.select = true;
//                         });
//                       }
//                     });
//                   }
//                   ids.push([metadataTypeXmlName, member].join('.'));
//                 }
//               } else {
//                 // id: ApexClass.MyClassName
//                 ids.push([metadataTypeXmlName, member].join('.'));
//               }
//             });
//           }
//         });
//       }
//       if (!self.indexService) {
//         self.indexService = new IndexService({ project: self });
//       }
//       self.indexService.setChecked(orgMetadata, ids);
//       self.indexService.ensureParentsAreCheckedIfNecessary(orgMetadata);
//       if (keyword) {
//         self.indexService.setVisibility(orgMetadata, keyword);
//       }
//       resolve(orgMetadata);
//     });
// };

/**
 * Indexes children Metadata by preparing and submitting retrieve requests
 * @param  {Object} indexedType
 * @param  {Object} typeMap
 * @param  {String} xmlName
 * @param  {Array} childNames
 * @return {Promise}
 */
Indexer.prototype._indexChildren = function(indexedType, typeMap, xmlName, childNames) {
  var self = this;
  return new Promise(function(resolve, reject) {
    try {
      logger.debug('_indexChildren -->'+xmlName);
      logger.debug(childNames);

      var childRetrievePackage = {};

      if (childNames && childNames.length > 0) {
        childRetrievePackage[xmlName] = childNames;
      }

      logger.debug('child retrieve package is: ');
      logger.debug(childRetrievePackage);

      var retrievePath = temp.mkdirSync({ prefix: 'mm_' });
      self.sfdcClient.retrieveUnpackaged(childRetrievePackage, true, retrievePath)
        .then(function(retrieveResult) {
          var finder = find(path.join(retrievePath, 'unpackaged', typeMap[xmlName].directoryName));
          finder.on('file', function (file) {

            var fileBasename = path.basename(file);
            var fileBasenameNoExtension = fileBasename.split('.')[0];
            var fileBody = util.getFileBodySync(file);

            logger.silly(fileBasename);
            logger.silly(fileBasenameNoExtension);
            logger.silly(fileBody);

            var indexedChildType = _.find(indexedType.children, { 'id': [xmlName,fileBasenameNoExtension].join('.') });

            logger.debug('indexedChildType -->', indexedChildType);

            parseXml(fileBody, function (err, xmlObject) {

              _.forOwn(xmlObject[xmlName], function(value, tagName) {

                // we're tracking this child type, now we need to add as a level 3 child
                // var matchingChildType = _.find(self.metadataHelper.childTypes, { 'tagName': tagName }); // todo: reimplement
                var matchingChildType = _.find(helper.childTypes, { tagName: tagName });
                if (matchingChildType) {

                  var leaves = [];

                  //now add level leaves (lowest level is 4 at the moment)
                  if (!_.isArray(value)) {
                    value = [value];
                  }
                  _.each(value, function(item) {
                    var key;
                    if (item.fullName) {
                      key = item.fullName[0];
                    } else if (item.actionName) {
                      key = item.actionName[0];
                    } else {
                      logger.error('Unrecognized child metadata type ', matchingChildType, item);
                    }
                    if (key) {
                      leaves.push({
                        leaf: true,
                        checked: false,
                        level: 4,
                        text: key,
                        title: key,
                        isFolder: false,
                        id: [xmlName, fileBasenameNoExtension, tagName, key].join('.'),
                        select: false
                      });
                    }
                  });

                  if ( !_.find(indexedChildType, { 'text' : tagName }) ) {
                    indexedChildType.children.push({
                      checked: false,
                      level: 3,
                      id: [xmlName, fileBasenameNoExtension, tagName].join('.'),
                      text: tagName,
                      title: tagName,
                      isFolder: true,
                      children: leaves,
                      select: false,
                      cls: 'folder'
                    });
                  }
                }
              });
            });
          });
          finder.on('end', function () {
            // todo: delete tmp directory?
            resolve(indexedType);
          });
          finder.on('error', function (err) {
            logger.error('Could not crawl retrieved metadata: '+err.message);
            reject(err);
          });
        })
        .catch(function(err) {
          logger.error('Could not index metadata type '+xmlName+': ' +err.message);
          logger.error(err.stack);
          reject(err);
        })
        .done();
    } catch(err) {
      logger.error('Could not index metadata type '+xmlName+': ' +err.message);
      reject(err);
    }
  });
};

/**
 * Indexes folder-based Metadata by preparing and submitting folder-based retrieve requests
 * @param  {Object} indexedType
 * @param  {Object} typeMap
 * @param  {String} xmlName
 * @return {Promise}
 */
Indexer.prototype._indexFolders = function(indexedType, typeMap, xmlName) {
  var self = this;
  return new Promise(function(resolve, reject) {
    var listFolderRequests = [];
    _.each(indexedType.children, function(folder) {
      listFolderRequests.push(self.sfdcClient.listFolder(xmlName, folder.fullName));
    });

    Promise.all(listFolderRequests)
      .then(function(results) {

        // console.log(results);
        // console.log('---')

        _.each(results, function(r) {

          var folderName = Object.keys(r)[0];
          var folderContents = r[folderName];

          var indexedFolder = _.find(indexedType.children, { 'text' : folderName });

          _.each(folderContents, function(item) {
            indexedFolder.children.push({
              leaf: true,
              title: item.fullName.split('/')[1],
              checked: false,
              text: item.fullName.split('/')[1],
              level: 3,
              isFolder: false,
              id: [xmlName, item.fullName.split('/')[0], item.fullName.split('/')[1]].join('.'),
              select: false
            });
          });

        });

        resolve(indexedType);
      })
      .catch(function(error) {
        logger.error('Could not finish indexing server properties: '+error.message);
        reject(error);
      })
      .done();
  });
};

/**
 * TODO: handle managed/unmanaged metadata
 *
 * Builds a 4-level hierarchy index for the specified type
 * @param  {Object} typeListResult
 * @param  {Object} typeMap
 * @return {Promise}
 */
Indexer.prototype._indexType = function(typeListResult, typeMap) {
  var self = this;
  return new Promise(function(resolve, reject) {
    // typeListResult will be an object with an xmlName key, array of results
    // { "ApexClass" : [ { "fullName" : "MyApexClass" }, { "fullName" : "MyOtherApexClass" } ] }

    logger.debug('indexing type ');
    logger.silly(typeListResult);

    var indexedType = {};
    var childNames = [];
    var hasChildTypes;
    var isFolderType;
    var xmlName;

    // process the type returned (ApexClass, ApexPage, CustomObject, etc.)
    _.forOwn(typeListResult, function(items, key) {
      if (util.endsWith(key,'Folder')) {
        key = self._transformFolderNameToBaseName(key);
      }

      logger.silly('key: '+key);
      logger.silly('items: ');
      logger.silly(items);

      xmlName = key;
      hasChildTypes = _.has(typeMap[key], 'childXmlNames');
      isFolderType = typeMap[key].inFolder;

      // top level (1)
      var metadataTypeDef = typeMap[key];
      indexedType.id = key;
      indexedType.type = metadataTypeDef;
      indexedType.title = key;
      indexedType.xmlName = key;
      indexedType.text = key;
      indexedType.key = key;
      indexedType.level = 1; //todo
      indexedType.hasChildTypes = hasChildTypes;
      indexedType.isFolder = true;
      indexedType.inFolder = isFolderType;
      indexedType.cls = 'folder';
      indexedType.select = false;
      indexedType.expanded = false;

      // children (2)
      _.each(items, function(item) {
        logger.silly('---->');
        logger.silly(item);
        item.fullName = item.fullName || new MavensMateFile({ path : item.fileName }).name;
        item.leaf = (hasChildTypes || isFolderType) ? false : true;
        item.title = item.fullName;
        item.checked = false;
        item.id = [key, item.fullName].join('.');
        item.text = item.fullName;
        item.cls = (hasChildTypes || isFolderType) ? 'folder' : '';
        item.level = 2;
        item.isFolder = hasChildTypes || isFolderType;
        item.children = [];
        item.select = false;

        if (hasChildTypes) {
          childNames.push(item.fullName);
        }
      });

      items = _.sortBy(items, 'title');
      indexedType.children = items;
    });

    var indexPromise;
    // we need to retrieve child metadata, crawl the result and insert levels 3 and 4 of metadata
    // examples of metadata types with child types: CustomObject or Workflow
    // examples of metadata types with folders: Document or Dashboard (folders go 1-level deep currently)
    if (hasChildTypes) {
      indexPromise = self._indexChildren(indexedType, typeMap, xmlName, childNames);
    } else if (isFolderType) {
      indexPromise = self._indexFolders(indexedType, typeMap, xmlName);
    }

    if (indexPromise !== undefined) {
      indexPromise
        .then(function(result) {
          resolve(result);
        })
        .catch(function(err) {
          logger.error('Could not index children/folders for '+xmlName+': '+err.message);
          reject(err);
        })
        .done();
    } else {
      resolve(indexedType);
    }
  });
};

/**
 * The Salesforce.com metadata api can be wonky, this transforms a folder type name to a list-friendly name
 * @param  {String} typeName
 * @return {String}
 */
Indexer.prototype._transformFolderNameForListRequest = function(typeName) {
  var metadataRequestType = typeName+'Folder';
  if (metadataRequestType === 'EmailTemplateFolder') {
    metadataRequestType = 'EmailFolder';
  }
  return metadataRequestType;
};

Indexer.prototype._transformFolderNameToBaseName = function(typeName) {
  if (typeName === 'EmailFolder') {
    return 'EmailTemplate';
  } else {
    return typeName.replace('Folder', '');
  }
};

/**
 * a number of protoype methods to crawl the org metadata index and select/deselect nodes
 */
Indexer.prototype._crawlDict = function(jsonData, depth, query, parentVisiblity) {
  var self = this;
  depth += 1;
  var visibility = 0;
  var childVisibility = 0;

  // if (!parentVisiblity) {
  //   parentVisiblity = 0;
  // }
  // console.log('crawling dict: ', jsonData);
  // console.log('parentVisiblity: ', parentVisiblity);

  _.forOwn(jsonData, function(value, key) {
    if (key === 'title') {
      // console.log('VALUE IS ---> ', value);
      // console.log('KEY IS ---> ', key);
      if (_.isString(value) && value.toLowerCase().indexOf(query) >= 0) {
        visibility = 1;
      } else if (!_.isObject(value) && !_.isArray(value) && value.toLowerCase().indexOf(query) >= 0) {
        visibility = 1;
      }
      // console.log(visibility);
    }
  });

  _.forOwn(jsonData, function(value, key) {
    if (self._crawl(value, depth, query, visibility) > 0) {
      childVisibility = 1;
    }
    if (visibility > childVisibility) {
      visibility = visibility;
    } else {
      visibility = childVisibility;
    }
  });

  jsonData.visibility = visibility;

  if (visibility === 0) {
    jsonData.cls = 'hidden';
    jsonData.addClass = 'dynatree-hidden';
  }

  return visibility;
};

Indexer.prototype._crawlArray = function(jsonData, depth, query, parentVisiblity) {
  var self = this;
  depth += 1;
  var elementsToRemove = [];
  var index = 0;
  var childVisibility;

  _.each(jsonData, function(value) {
    if (_.isString(value)) {
      childVisibility = value.toLowerCase().indexOf(query) >= 0;
    } else if (_.isObject(value)) {
      childVisibility = self._crawl(value, depth, query, parentVisiblity);
      value.index = index;
    } else {
      childVisibility = value.toLowerCase().indexOf(query) >= 0;
    }

    if (childVisibility === 0 && parentVisiblity === 0) {
      elementsToRemove.push(value);
      value.cls = 'hidden';
      value.addClass = 'dynatree-hidden';
    } else {
      if (value.isFolder) {
        value.expanded = true;
      }
    }

    index += 1;
  });
};

Indexer.prototype._crawl = function(jsonData, depth, query, parentVisiblity) {
  var self = this;
  if (_.isArray(jsonData)) {
    self._crawlArray(jsonData, depth, query, parentVisiblity);
    var hv = false;
    _.each(jsonData, function(jd) {
      if (_.has(jd, 'visibility') && jd.visibility === 1) {
        hv = true;
        return false;
      }
    });
    return hv;
  } else if (_.isObject(jsonData)) {
    return self._crawlDict(jsonData, depth, query, parentVisiblity);
  } else {
    return 0;
  }
};

Indexer.prototype._setThirdStateChecked = function(src, ids, dpth, key) {
  // Recursively find checked item
  var self = this;

  if (!key) key = '';
  if (!ids) ids = [];
  if (!dpth) dpth = 0;

  if (_.isArray(src)) {
    _.each(src, function(litem) {
      if (_.isObject(litem)) {
        return false;
      }
      self._setThirdStateChecked(litem, ids, dpth + 2);
    });
  } else if (_.isObject(src)) {
    if (_.has(src, 'children') && _.isArray(src.children) && src.children.length > 0) {
      var children = src.children;
      var numberOfPossibleChecked = children.length;
      var numberOfChecked = 0;
      _.each(children, function(c) {
        if (_.has(c, 'checked') && c.checked) {
          numberOfChecked += 1;
        }
      });
      if (numberOfPossibleChecked === numberOfChecked) {
        src.checked = true;
      } else if (numberOfChecked > 0) {
        src.cls = 'x-tree-checkbox-checked-disabled';
      }
    }

    _.forOwn(src, function(value, key) {
      self._setThirdStateChecked(value, ids, dpth + 1, key);
    });
  }
};

module.exports = Indexer;