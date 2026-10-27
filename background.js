'use strict';

// Clicar no ícone abre o painel lateral, onde fica toda a extensão.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
