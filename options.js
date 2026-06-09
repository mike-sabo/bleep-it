var userList = document.getElementById('user-list');
var updatedUserList = [];
var restore_options = function () {
    var enableWordResult = false;
    
    registerListeners();
    getUserList();
};

//Get userList from chrome sync storage
var getUserList = function () {
    chrome.storage.sync.get('userAddedWords', function (items) {
        if (items.userAddedWords != null) {
            createUserList(items.userAddedWords);
        }
    });
};

var createUserList = function (words) {
    if (words != null) {
        words.forEach(function (word) {
            addWordToList(word);
        }, this);
    }
};

var duplicate = function (word) {
    
};

var addWordToList = function (word) {
    if (word != null && word != '') {

        if (!updatedUserList.includes(word)) {
            var node = document.createElement('li');
            var textnode = document.createTextNode(word);
            var span = document.createElement('span');

            span.className = ''
            node.className = 'list-group-item';
            node.appendChild(textnode);
            userList.appendChild(node);
            saveUserList();
        } else {
            alert('Duplicate word detected!');
        }
    }
};

var updateUserList = function () {
    var userListItems = userList.getElementsByTagName('li');
  
    if (userListItems.length > 0) {
        updatedUserList = [];
        for (var i = 0; i < userListItems.length; i++) {
            updatedUserList.push(userListItems[i].innerText);
        }
    } else {
        alert('It appears your word list is empty.');
    }
};


var saveUserList = function () {
    updateUserList();

    chrome.storage.sync.set({
        'userAddedWords': updatedUserList
    }, function (items) {
        chrome.notifications.create('', opt, function () {});
    });

    document.getElementById('new-word').value = '';
};

//Change the value of the settings object
var toggleCleanWord = function () {
    var wordEnabled = document.getElementById('radioYes').checked;

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

var registerListeners = function () {
    document.getElementById("add-word").addEventListener("click", function () {
        var newWord = document.getElementById('new-word').value;
        addWordToList(newWord);
    });
};

document.addEventListener('DOMContentLoaded', restore_options);