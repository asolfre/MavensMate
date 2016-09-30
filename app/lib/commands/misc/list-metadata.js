/**
 * @file Returns an active salesforce session
 * @author Joseph Ferraro <@joeferraro>
 */

'use strict';

var Promise               = require('bluebird');
var util                  = require('../../util');
var inherits              = require('inherits');
var BaseCommand           = require('../../command');
var SalesforceClient      = require('../../sfdc-client');
var Indexer               = require('../../org/index');
var _                     = require('lodash');
var logger                = require('winston');

function Command() {
  BaseCommand.call(this, arguments);
}

inherits(Command, BaseCommand);

Command.prototype.execute = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    logger.debug('payload', self.payload);
    var sfdcClient = new SalesforceClient({
      accessToken: self.payload.accessToken,
      instanceUrl: self.payload.instanceUrl,
      transient: true
    });
    sfdcClient.initialize()
      .then(function() {
        var indexer = new Indexer(sfdcClient, self.payload.metadataTypes);
        return indexer.index();
      })
      .then(function(index) {
        resolve(index);
      })
      .catch(function(error) {
        reject(error);
      });
  });
};

exports.command = Command;
exports.addSubCommand = function(program) {
  program
    .command('list-metadata [typeXmlName')
    .description('Lists metadata for given type')
    .action(function(typeXmlName) {
      if (typeXmlName) {
        program.commandExecutor.execute({
          name: this._name,
          body: {
           metadataTypes: [typeXmlName]
          }
        });
      } else {
        var self = this;
        util.getPayload()
          .then(function(payload) {
            program.commandExecutor.execute({
              name: self._name,
              body: payload,
              editor: self.parent.editor
            });
          });
      }
    });
};