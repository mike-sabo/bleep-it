var opt = {
    type: "basic",
    title: "Bleep It!",
    message: "Your word has been successfully added!",
    iconUrl: "toast.png"
};

var settings = {
    useBuiltInDict: false,
    useSillyWords: false,
    revealUserWords: false
};

var menu = chrome.contextMenus.create({
    "title": "Bleep Word!",
    "contexts": ["selection"],
    "onclick": bleepWord
});


chrome.storage.sync.get('bleepSettings', function (items) {
    if (items) {
        var settings = JSON.parse(items);
    }
});

function bleepWord(info) {
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

function createDefaultSettings() {
     chrome.storage.sync.set({'bleepSettings': theValue}, function() {
          // Notify that we saved.
          message('Settings saved');
        });
}