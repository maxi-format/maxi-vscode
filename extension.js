'use strict';

const path = require('path');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
  const serverModule = context.asAbsolutePath(path.join('server.js'));

  const serverOptions = {
    run:   { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc,
             options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };

  const clientOptions = {
    documentSelector: [{ scheme: 'file', language: 'maxi' }],
  };

  client = new LanguageClient(
    'maxi-language-server',
    'MAXI Language Server',
    serverOptions,
    clientOptions
  );

  client.start();
  context.subscriptions.push(client);
}

function deactivate() {
  if (client) return client.stop();
}

module.exports = { activate, deactivate };
