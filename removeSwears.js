var userKeys;
var enableWordsResult;

//      Get all storage keys for extension
chrome.storage.sync.get('userAddedWords', function(userWords) {
    userKeys = userWords.userAddedWords;
});

//     Grab the options setting
chrome.storage.sync.get('enableWords', function(items) {
    enableWordsResult = items.enableWords;
});

//      Replace Text
$(document).ready(function () {
    var temp_url = chrome.extension.getURL("badwords.txt");
    var temp_url2 = chrome.extension.getURL("goodwords.txt");
    $.ajax({
        url: temp_url,
        success: function (result) {
            var badWords = result.split(",");

            $.ajax({
                url: temp_url2,
                success: function (result) {
                    var goodWords = result.split(",");

                    //      Remove words based on stock dictionary
                    if(enableWordsResult == 'True') {
                        for (var i = 0; i < badWords.length; i++) {
                            var randomNum = Math.floor(Math.random() * goodWords.length + 1);
                            var regex = new RegExp('\\b' + badWords[i] + '\\b', 'gi');

                            $("body *").replaceText(regex, goodWords[randomNum]);
                        }
                    } else {
                        for (var i = 0; i < badWords.length; i++) {
                            var regex = new RegExp('\\b' + badWords[i] + '\\b', 'gi');

                            $("body *").replaceText(regex, "#@$!%");
                        }
                    }

                    //      Remove words based on user dictionary
                    if(userKeys !== null) {
                        if(enableWordsResult == 'True') {
                            for (var j = 0; j < userKeys.length; j++) {
                                var randomNum = Math.floor(Math.random() * goodWords.length + 1);
                                var regex = new RegExp('\\b' + userKeys[j] + '\\b', 'gi');

                                $("body *").replaceText(regex, goodWords[randomNum]);
                            }
                        } else {
                            for (var j = 0; j < userKeys.length; j++) {
                                var regex = new RegExp('\\b' + userKeys[j] + '\\b', 'gi');

                                $("body *").replaceText(regex, "#@$!%");
                            }
                        }
                    }
                }
            })
        }
    });
});