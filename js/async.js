/*******************************************************************************

    httpswitchboard - a Chromium browser extension to black/white list requests.
    Copyright (C) 2013  Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/httpswitchboard
*/

/* global chrome, HTTPSB */

/******************************************************************************/

// Async job queue module

HTTPSB.asyncJobs = (function() {

var processJobs = function() {
    asyncJobManager.process();
};

var AsyncJobEntry = function(name) {
    this.name = name;
    this.data = null;
    this.callback = null;
    this.when = 0;
    this.period = 0;
};

AsyncJobEntry.prototype.destroy = function() {
    this.name = '';
    this.data = null;
    this.callback = null;
};

var AsyncJobManager = function() {
    this.timeResolution = 200;
    this.jobs = {};
    this.jobCount = 0;
    this.jobJunkyard = [];
    this.timerId = null;
    this.timerWhen = Number.MAX_VALUE;
};

AsyncJobManager.prototype.restartTimer = function() {
    var when = Number.MAX_VALUE;
    var jobs = this.jobs, job;
    for ( var jobName in jobs ) {
        job = jobs[jobName];
        if ( job instanceof AsyncJobEntry ) {
            if ( job.when < when ) {
                when = job.when;
            }
        }
    }
    // Quantize time value
    when = Math.floor((when + this.timeResolution - 1) / this.timeResolution) * this.timeResolution;

    if ( when < this.timerWhen ) {
        clearTimeout(this.timerId);
        this.timerWhen = when;
        this.timerId = setTimeout(processJobs, Math.max(when - Date.now(), 10));
    }
};

AsyncJobManager.prototype.add = function(name, data, callback, delay, recurrent) {
    var job = this.jobs[name];
    if ( !job ) {
        job = this.jobJunkyard.pop();
        if ( !job ) {
            job = new AsyncJobEntry(name);
        } else {
            job.name = name;
        }
        this.jobs[name] = job;
        this.jobCount++;
    }
    job.data = data;
    job.callback = callback;
    job.when = Date.now() + delay;
    job.period = recurrent ? delay : 0;
    this.restartTimer();
};

AsyncJobManager.prototype.process = function() {
    this.timerId = null;
    this.timerWhen = Number.MAX_VALUE;
    var now = Date.now();
    var job;
    for ( var jobName in this.jobs ) {
        if ( this.jobs.hasOwnProperty(jobName) === false ) {
            continue;
        }
        job = this.jobs[jobName];
        if ( job.when > now ) {
            continue;
        }
        job.callback(job.data);
        if ( job.period ) {
            job.when = now + job.period;
        } else {
            delete this.jobs[jobName];
            job.destroy();
            this.jobCount--;
            this.jobJunkyard.push(job);
        }
    }
    this.restartTimer();
};

// Only one instance
var asyncJobManager = new AsyncJobManager();

// Publish
return asyncJobManager;

})();

/******************************************************************************/

// Update visual of extension icon.
// A time out is used to coalesce adjacent requests to update badge.

HTTPSB.updateBadge = function(pageUrl) {
    var updateBadgeCallback = function(pageUrl) {
        var httpsb = HTTPSB;
        if ( pageUrl === httpsb.behindTheSceneURL ) {
            return;
        }
        var tabId = httpsb.tabIdFromPageUrl(pageUrl);
        if ( !tabId ) {
            return;
        }
        var pageStats = httpsb.pageStatsFromTabId(tabId);
        if ( pageStats ) {
            pageStats.updateBadge(tabId);
        } else {
            chrome.browserAction.setIcon({ tabId: tabId, path: 'img/browsericons/icon19.png' });
            chrome.browserAction.setBadgeText({ tabId: tabId, text: '?' });
        }
    };

    this.asyncJobs.add('updateBadge ' + pageUrl, pageUrl, updateBadgeCallback, 250);
};

/******************************************************************************/

// Notify whoever care that whitelist/blacklist have changed (they need to
// refresh their matrix).

HTTPSB.permissionsChanged = function() {
    var permissionChangedCallback = function() {
        chrome.runtime.sendMessage({ 'what': 'permissionsChanged' });
    };

    this.asyncJobs.add('permissionsChanged', null, permissionChangedCallback, 250);
};

/******************************************************************************/

function gotoExtensionURL(url) {

    var hasFragment = function(url) {
        return url.indexOf('#') >= 0;
    };

    var removeFragment = function(url) {
        var pos = url.indexOf('#');
        if ( pos < 0 ) {
            return url;
        }
        return url.slice(0, pos);
    };

    var tabIndex = 9999;
    var targetUrl = chrome.extension.getURL(url);
    var urlToFind = removeFragment(targetUrl);

    var currentWindow = function(tabs) {
        var updateProperties = { active: true };
        var i = tabs.length;
        while ( i-- ) {
            if ( removeFragment(tabs[i].url) !== urlToFind ) {
                continue;
            }
            // If current tab in dashboard is different, force the new one, if
            // there is one, to be activated.
            if ( tabs[i].url !== targetUrl ) {
                if ( hasFragment(targetUrl) ) {
                    updateProperties.url = targetUrl;
                }
            }
            // Activate found matching tab
            // Commented out as per:
            // https://github.com/gorhill/httpswitchboard/issues/150#issuecomment-32683726
            // chrome.tabs.move(tabs[0].id, { index: index + 1 });
            chrome.tabs.update(tabs[i].id, updateProperties);
            return;
        }
        chrome.tabs.create({ 'url': targetUrl, index: tabIndex + 1 });
    };

    var currentTab = function(tabs) {
        if ( tabs.length ) {
            tabIndex = tabs[0].index;
        }
        chrome.tabs.query({ currentWindow: true }, currentWindow);
    };

    // https://github.com/gorhill/httpswitchboard/issues/150
    // Logic:
    // - If URL is already opened in a tab, just activate tab
    // - Otherwise find the current active tab and open in a tab immediately
    //   to the right of the active tab
    chrome.tabs.query({ active: true }, currentTab);
}

/******************************************************************************/

// Notify whoever care that url stats have changed (they need to
// rebuild their matrix).

HTTPSB.urlStatsChanged = function(pageUrl) {
    var urlStatsChangedCallback = function(pageUrl) {
        // rhill 2013-11-17: No point in sending this message if the popup menu
        // does not exist. I suspect this could be related to
        // https://github.com/gorhill/httpswitchboard/issues/58
        var httpsb = HTTPSB;
        if ( httpsb.port ) {
            httpsb.port.postMessage({
                what: 'urlStatsChanged',
                pageURL: pageUrl
            });
        }
    };

    this.asyncJobs.add('urlStatsChanged ' + pageUrl, pageUrl, urlStatsChangedCallback, 1000);
};

/******************************************************************************/

// Handling stuff asynchronously simplifies code

function onMessageHandler(request, sender, callback) {
    var response;

    if ( request && request.what ) {
        switch ( request.what ) {

        case 'allLocalAssetsUpdated':
            HTTPSB.reloadAllLocalAssets();
            break;

        case 'forceReloadTab':
            HTTPSB.forceReload(request.pageURL);
            break;

        case 'gotoExtensionURL':
            gotoExtensionURL(request.url);
            break;

        case 'gotoURL':
            if ( request.tabId ) {
                chrome.tabs.update(request.tabId, { url: request.url });
            } else {
                chrome.tabs.create({ url: request.url });
            }
            break;

        case 'localAssetUpdated':
            HTTPSB.onLocalAssetUpdated(request);
            break;

        case 'reloadPresetBlacklists':
            HTTPSB.reloadPresetBlacklists(request.switches);
            break;

        case 'userSettings':
            if ( typeof request.name === 'string' && request.name !== '' ) {
                response = changeUserSettings(request.name, request.value);
            }
            break;

        default:
             // console.error('HTTP Switchboard > onMessage > unknown request: %o', request);
            break;
        }
    }

    if ( response !== undefined && callback ) {
        callback(response);
    }
}

chrome.runtime.onMessage.addListener(onMessageHandler);
