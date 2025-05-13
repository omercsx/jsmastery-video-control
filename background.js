// Add a flag to track if a command is currently being processed
let isProcessingCommand = false;

// Listen for keyboard commands
chrome.commands.onCommand.addListener((command) => {

  // Prevent rapid-fire commands that could cause conflicts
  if (isProcessingCommand) {
    return;
  }

  isProcessingCommand = true;

  // Get the active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      const activeTab = tabs[0];

      // First try to send a message to see if content script is already running
      try {
        chrome.tabs.sendMessage(
          activeTab.id,
          { action: 'ping' },
          function (response) {
            if (chrome.runtime.lastError || !response) {
              injectContentScriptAndSendCommand(activeTab.id, command);
            } else {
              sendCommandToContentScript(activeTab.id, command);
            }
          }
        );
      } catch (error) {
        injectContentScriptAndSendCommand(activeTab.id, command);

        // Release the command processing lock after a delay
        setTimeout(() => {
          isProcessingCommand = false;
        }, 500);
      }
    } else {
      isProcessingCommand = false;
    }
  });
});

// Function to inject content script and then send command
function injectContentScriptAndSendCommand(tabId, command) {
  chrome.scripting.executeScript({
    target: { tabId: tabId, allFrames: true },
    files: ['content.js']
  })
    .then(() => {
      // Wait a moment to make sure the content script is fully loaded
      setTimeout(() => {
        sendCommandToContentScript(tabId, command);
      }, 200); // Increased from 100 to 200 for more reliable loading
    })
    .catch(error => {

      // Try a direct script injection as a fallback
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: executeCommandDirectly,
        args: [command]
      }).catch(err => {
      }).finally(() => {
        // Release the command processing lock
        setTimeout(() => {
          isProcessingCommand = false;
        }, 300);
      });
    });
}

// Function to send command to content script
function sendCommandToContentScript(tabId, command) {
  chrome.tabs.sendMessage(
    tabId,
    { action: 'controlVideo', command: command },
    function (response) {

      // Release the command processing lock after a delay
      setTimeout(() => {
        isProcessingCommand = false;
      }, 300);
    }
  );
}

// Function to be injected directly if content script fails
function executeCommandDirectly(command) {

  // Try to detect the specific player pattern first (like seen in screenshot)
  const controlGroups = document.querySelectorAll('[class*="controls"], [class*="Controls"], [class*="player"], [class*="Player"]');

  for (const group of controlGroups) {
    const buttons = group.querySelectorAll('button');
    if (buttons.length >= 3) {
      // Found a potential match to the layout in the screenshot (3 buttons in a row)

      // Map commands to positions in the 3-button control layout (based on screenshot)
      const positionMap = {
        'play-pause': 0,   // Left button (pause)
        'rewind': 1,       // Middle button (-10s)
        'fast-forward': 2  // Right button (+10s)
      };

      const targetIndex = positionMap[command];
      if (targetIndex !== undefined && targetIndex < buttons.length) {
        const targetButton = buttons[targetIndex];

        try {
          // Try multiple ways to click the button
          ['mousedown', 'mouseup', 'click'].forEach(eventType => {
            targetButton.dispatchEvent(new MouseEvent(eventType, {
              view: window,
              bubbles: true,
              cancelable: true,
              composed: true
            }));
          });

          targetButton.click();
          return true;
        } catch (e) {
          // Continue to try other methods
        }
      }
    }
  }

  // Try to find video element
  const videos = document.querySelectorAll('video');
  if (videos.length > 0) {
    // Find the most relevant video (prefer playing ones)
    let video = videos[0];
    for (const v of videos) {
      if (!v.paused) {
        video = v;
        break;
      }
    }

    switch (command) {
      case 'fast-forward':
        video.currentTime += 10;
        return true;
      case 'rewind':
        video.currentTime -= 10;
        return true;
      case 'play-pause':
        if (video.paused) {
          const playPromise = video.play();
          if (playPromise !== undefined) {
            playPromise.catch(error => { });
          }
        } else {
          video.pause();
        }
        return true;
    }
  } else {
    // Try multiple approaches to find and click control buttons

    // 1. Check for common video player button classes and aria-labels
    const buttonSelectors = {
      'play-pause': 'button[aria-label*="play"], button[aria-label*="pause"], button.ytp-play-button, button.vjs-play-control, button[title*="play"], button[title*="pause"]',
      'rewind': 'button[aria-label*="rewind"], button[aria-label*="back"], button[aria-label*="previous"], button[title*="rewind"], button[title*="back"], button[title*="-10"]',
      'fast-forward': 'button[aria-label*="forward"], button[aria-label*="next"], button[title*="forward"], button[title*="next"], button[title*="+10"]'
    };

    if (buttonSelectors[command]) {
      const buttons = document.querySelectorAll(buttonSelectors[command]);
      if (buttons.length > 0) {

        // Click all matching buttons to maximize chances of success
        for (const button of buttons) {
          try {
            button.click();
          } catch (e) {
            console.error('Error clicking button:', e);
          }
        }
        return true;
      }
    }

    // 2. Try looking at the button contents for clues
    const innerTextMap = {
      'play-pause': ['play', 'pause'],
      'rewind': ['rewind', 'back', 'prev', '-10'],
      'fast-forward': ['forward', 'next', '+10']
    };

    const textTerms = innerTextMap[command] || [];
    const allButtons = document.querySelectorAll('button');

    for (const btn of allButtons) {
      const innerHTML = btn.innerHTML.toLowerCase();
      const innerText = btn.textContent?.toLowerCase() || '';

      for (const term of textTerms) {
        if (innerHTML.includes(term.toLowerCase()) || innerText.includes(term.toLowerCase())) {
          btn.click();
          return true;
        }
      }
    }

    // 3. Try keyboard events as a last resort
    const keyMap = {
      'fast-forward': { key: 'ArrowRight', keyCode: 39 },
      'rewind': { key: 'ArrowLeft', keyCode: 37 },
      'play-pause': { key: 'k', keyCode: 75, alt: [' ', 32] }  // Try both K and Space for play/pause
    };

    if (keyMap[command]) {
      const { key, keyCode, alt } = keyMap[command];

      // Try primary key
      ['keydown', 'keyup'].forEach(eventType => {
        document.dispatchEvent(new KeyboardEvent(eventType, {
          key: key,
          keyCode: keyCode,
          which: keyCode,
          bubbles: true,
          cancelable: true
        }));
      });

      // Try alternate key if available
      if (alt) {
        const [altKey, altKeyCode] = alt;

        ['keydown', 'keyup'].forEach(eventType => {
          document.dispatchEvent(new KeyboardEvent(eventType, {
            key: altKey,
            keyCode: altKeyCode,
            which: altKeyCode,
            bubbles: true,
            cancelable: true
          }));
        });
      }

      return true;
    }
  }

  return false;
} 