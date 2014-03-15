//Put options page in this function to alleviate some issues the the options page and calling DOM objects when not ready.
document.addEventListener('DOMContentLoaded', function () {
    //Notification options
    var opt = {
        type: "basic",
        title: "Bleep It!",
        message: "Word list updated!",
        iconUrl: "toast.png"
    };

    var enableWordResult;

    //If first launch, set option to False.
    chrome.storage.sync.get('enableWords', function (items) {
        enableWordsResult = items.enableWords;

        //Set radio to current value
        if (enableWordsResult == 'True') {
            document.getElementById("radioYes").checked = true;
        } else {
            document.getElementById("radioNo").checked = true;
        }
    });

    //Show user added words in text area
    var getUserWords = function () {
        chrome.storage.sync.get('userAddedWords', function (items) {
            if (items.userAddedWords == null) {
                document.getElementById("userAddedWords").value = "No user defined words found.";
            } else {
                if (typeof items.userAddedWords === 'string') {
                    document.getElementById("userAddedWords").value = items.userAddedWords;
                } else {
                    var getWords = items.userAddedWords.join();
                    getWords = getWords.replace(/,/gi, '\n');
                    document.getElementById("userAddedWords").value = getWords;
                }
            }
        })
    };

    //Clear Text Area
    var clearUserWords = function () {
        document.getElementById("userAddedWords").value = "";
    };


    //Change the value of the settings object
    var toggleCleanWord = function () {
        var wordEnabled = document.getElementById("radioYes").checked;

        if (wordEnabled == true) {
            chrome.storage.sync.set({
                'enableWords': 'True'
            }, function () {});
        } else {
            chrome.storage.sync.set({
                'enableWords': 'False'
            }, function () {});
        }
    };

    var updateUserAddedWords = function () {
        var setWords = document.getElementById("userAddedWords").value;

        if (setWords == "") {
            if (confirm('Your user-added list appears to be empty, are you sure you want to erase all of your words?')) {
                chrome.storage.sync.set({
                    'userAddedWords': null
                }, function (items) {
                    chrome.notifications.create("", opt, function () {});
                    getUserWords();
                });
            } else {
                getUserWords();
            }
        } else {
            setWords = setWords.replace(/\n/gi, ',');
            setWords = setWords.split(',');
            chrome.storage.sync.set({
                'userAddedWords': setWords
            }, function (items) {
                chrome.notifications.create("", opt, function () {});
                getUserWords();
            });
        }
    }

    document.querySelector('#radioYes').addEventListener('click', toggleCleanWord);
    document.querySelector('#radioNo').addEventListener('click', toggleCleanWord);
    document.querySelector('#userRadioYes').addEventListener('click', getUserWords);
    document.querySelector('#userRadioNo').addEventListener('click', clearUserWords);
    document.querySelector('#updateWordListButton').addEventListener('click', updateUserAddedWords);
});