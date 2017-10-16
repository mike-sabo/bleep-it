var userKeys;
var enableWordsResult;
var temp_url;
var temp_url2;
var badWords = "";
var goodWords = "";
    
//Function to replace inapproprate with silly words
var filterWithWords = function () { 
    for (var i = 0; i < goodWords.length; i++) {
        var randomNum = Math.floor(Math.random() * goodWords.length + 1);
        var regex = new RegExp('\\b' + goodWords[i] + '\\b', 'gi');
        $("body *").replaceText(regex, goodWords[randomNum]);
    }   
};

//Function to replace inapproprate with symbols
var filterWithSymbols = function () {
    for (var i = 0; i < badWords.length; i++) {
        var regex = new RegExp('\\b' + badWords[i] + '\\b', 'gi');
        $("body *").replaceText(regex, "#@$!%");
    }
};

//Get good and bad words
var prepare = function () {
//Get the bad words
    $.ajax({
        url: temp_url,
        success: function (result) {
            badWords = result.split(",");
            if (userKeys != null) {
                if (Array.isArray(userKeys)) {
                    for (var i = 0; i < userKeys.length; i++){
                        badWords.push(userKeys[i]);
                    }
                } else {
                    badWords.push(userKeys);
                }   
            }
        },
        async: false
    });

    //Get the good words
    $.ajax({
        url: temp_url2,
        success: function (result) {
            goodWords = result.split(",");   
        },
        async: false
    });

    //Call method which does the magic
    if (enableWordsResult == 'True') {
        filterWithWords();
    } else {
        filterWithSymbols();
    }
};

//Get all storage keys for extension
var getUserWords = function () {
    chrome.storage.sync.get('userAddedWords', function (userWords) {
        userKeys = userWords.userAddedWords;
        prepare();
    });
};

//Grab the options setting
var getOptions = function () {
    chrome.storage.sync.get('enableWords', function (items) {
        enableWordsResult = items.enableWords;
        getUserWords();
    })
};

//Get dictionaries
$(document).ready(function () {
    //Prepare the urls to get good / bad words
    temp_url = chrome.extension.getURL("badwords.txt");
    temp_url2 = chrome.extension.getURL("goodwords.txt");
  
    getOptions();
});