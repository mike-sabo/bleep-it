//If first launch, set option to False.
chrome.storage.sync.get('enableWords', function (items) {
    var enableWordsResult = items.enableWords;

    if (typeof enableWordsResult === 'undefined') {
        chrome.storage.sync.set({
            'enableWords': 'False'
        }, function () {});
    }
});

//Bleep Word - this will add highlighted word to sync storage
var bleepWord = function (info) {
    //chrome.storage.sync.clear();
    
    chrome.storage.sync.get('userAddedWords', function (userWords) {

        if(userWords.userAddedWords == null) {
            chrome.storage.sync.set({'userAddedWords': info.selectionText}, function(){});
        } else {
            if (typeof userWords.userAddedWords === 'string') {
                chrome.storage.sync.set({'userAddedWords': [userWords.userAddedWords, info.selectionText]});
            } else {
                userWords.userAddedWords.push(info.selectionText);
                chrome.storage.sync.set({'userAddedWords': userWords.userAddedWords});   
            }
        }

        chrome.notifications.create("", opt, function() {});
    });
};

//Notification options
var opt = {
    type: "basic",
    title: "Bleep It!",
    message: "Your word has been successfully added!",
    iconUrl: "toast.png"
};

//Creates right-click menu item
var menu = chrome.contextMenus.create({
    "title": "Bleep Word!",
    "contexts": ["selection"],
    "onclick": bleepWord
});