(() => {
  const WIDTH = 900;
  const HEIGHT = 420;
  const GROUND_Y = 350;
  const WORLD_HEIGHT = 350;
  const PICKLE_HEIGHT = 48;

  const colors = {
    ink: "#1f3020",
    cream: "#fff8df",
    tile: "#f5edcf",
    tileLine: "#d8d5b4",
    brine: "#d3e3bc",
    green: "#6fa642",
    greenDark: "#315f25",
    lime: "#b5df70",
    red: "#d8523b",
    yellow: "#f0bd3d",
    blue: "#78a8a4",
    counter: "#c98f62",
    counterDark: "#8e5f44",
  };

  function roundedRect(context, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.roundRect(x, y, width, height, safeRadius);
  }

  function drawWall(context, cameraX) {
    context.fillStyle = colors.cream;
    context.fillRect(0, 0, WIDTH, GROUND_Y);

    context.strokeStyle = colors.tileLine;
    context.lineWidth = 2;
    const tileWidth = 90;
    const tileHeight = 70;
    const offset = -((cameraX * 0.08) % tileWidth);
    for (let x = offset - tileWidth; x < WIDTH + tileWidth; x += tileWidth) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, GROUND_Y);
      context.stroke();
    }
    for (let y = 70; y < GROUND_Y; y += tileHeight) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(WIDTH, y);
      context.stroke();
    }

    context.fillStyle = colors.blue;
    for (let x = 120 - ((cameraX * 0.04) % 520); x < WIDTH + 180; x += 520) {
      context.fillRect(x, 105, 150, 8);
      context.fillStyle = colors.ink;
      context.fillRect(x + 12, 113, 5, 18);
      context.fillRect(x + 132, 113, 5, 18);
      context.fillStyle = colors.yellow;
      roundedRect(context, x + 24, 69, 34, 36, 6);
      context.fill();
      context.fillStyle = colors.red;
      roundedRect(context, x + 67, 79, 28, 26, 5);
      context.fill();
      context.fillStyle = colors.green;
      roundedRect(context, x + 104, 61, 30, 44, 6);
      context.fill();
      context.fillStyle = colors.blue;
    }
  }

  function drawCounter(context, cameraX) {
    context.fillStyle = colors.counter;
    context.fillRect(0, GROUND_Y, WIDTH, HEIGHT - GROUND_Y);
    context.fillStyle = colors.counterDark;
    context.fillRect(0, GROUND_Y, WIDTH, 10);
    context.fillRect(0, HEIGHT - 12, WIDTH, 12);

    context.strokeStyle = "#b97953";
    context.lineWidth = 3;
    const offset = -((cameraX * 0.35) % 150);
    for (let x = offset - 150; x < WIDTH + 150; x += 150) {
      context.beginPath();
      context.moveTo(x, GROUND_Y + 11);
      context.lineTo(x + 35, HEIGHT - 12);
      context.stroke();
    }
  }

  function drawCeilingDanger(context, averageVolume) {
    context.fillStyle = averageVolume > 0.8 ? "#f5c1a9" : "#f3d4ba";
    context.fillRect(0, 0, WIDTH, 44);
    context.fillStyle = colors.red;
    context.beginPath();
    for (let x = 0; x < WIDTH; x += 24) {
      context.moveTo(x, 0);
      context.lineTo(x + 12, 42);
      context.lineTo(x + 24, 0);
    }
    context.fill();

    context.fillStyle = colors.ink;
    context.font = "900 11px Trebuchet MS";
    context.letterSpacing = "1px";
    context.fillText("TOO LOUD", 16, 18);
  }

  function drawTargetLine(context, averageVolume) {
    const targetY = GROUND_Y - averageVolume * WORLD_HEIGHT;
    context.save();
    context.setLineDash([7, 9]);
    context.strokeStyle = averageVolume > 0.8 ? colors.red : colors.greenDark;
    context.globalAlpha = 0.38;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(90, targetY);
    context.lineTo(WIDTH - 30, targetY);
    context.stroke();
    context.restore();
  }

  function drawFloorObstacle(context, obstacle, screenX) {
    const y = GROUND_Y - obstacle.height;
    const type = obstacle.id % 4;
    context.save();
    context.strokeStyle = colors.ink;
    context.lineWidth = 4;

    if (type === 0) {
      context.fillStyle = colors.red;
      roundedRect(context, screenX, y + 8, obstacle.width, obstacle.height - 8, 8);
      context.fill();
      context.stroke();
      context.fillStyle = colors.cream;
      context.fillRect(screenX + 7, y + obstacle.height * 0.45, obstacle.width - 14, 10);
    } else if (type === 1) {
      context.fillStyle = colors.yellow;
      roundedRect(context, screenX, y + 4, obstacle.width * 0.78, obstacle.height - 4, 7);
      context.fill();
      context.stroke();
      context.beginPath();
      context.arc(screenX + obstacle.width * 0.79, y + obstacle.height * 0.58, obstacle.width * 0.25, -1.3, 1.3);
      context.stroke();
    } else if (type === 2) {
      context.fillStyle = colors.blue;
      roundedRect(context, screenX + 4, y, obstacle.width - 8, obstacle.height, 5);
      context.fill();
      context.stroke();
      context.fillStyle = colors.cream;
      context.fillRect(screenX + 10, y + 12, obstacle.width - 20, 14);
      context.fillStyle = colors.ink;
      context.fillRect(screenX + obstacle.width / 2 - 7, y + 16, 14, 5);
    } else {
      context.fillStyle = colors.green;
      roundedRect(context, screenX + obstacle.width * 0.18, y, obstacle.width * 0.64, obstacle.height, 10);
      context.fill();
      context.stroke();
      context.fillStyle = colors.yellow;
      context.fillRect(screenX + obstacle.width * 0.28, y + obstacle.height * 0.45, obstacle.width * 0.44, 8);
    }
    context.restore();
  }

  function drawCeilingObstacle(context, obstacle, screenX) {
    const type = obstacle.id % 3;
    context.save();
    context.strokeStyle = colors.ink;
    context.lineWidth = 4;

    if (type === 0) {
      context.strokeRect(screenX + obstacle.width / 2 - 2, 0, 4, obstacle.height * 0.45);
      context.fillStyle = colors.red;
      context.beginPath();
      context.arc(screenX + obstacle.width / 2, obstacle.height * 0.7, obstacle.width * 0.43, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    } else if (type === 1) {
      context.fillStyle = colors.blue;
      roundedRect(context, screenX + obstacle.width * 0.35, 0, obstacle.width * 0.3, obstacle.height * 0.58, 5);
      context.fill();
      context.stroke();
      context.fillStyle = colors.ink;
      context.beginPath();
      context.ellipse(screenX + obstacle.width / 2, obstacle.height * 0.78, obstacle.width * 0.45, obstacle.height * 0.2, 0, 0, Math.PI * 2);
      context.fill();
    } else {
      context.fillStyle = colors.yellow;
      roundedRect(context, screenX, 0, obstacle.width, obstacle.height, 4);
      context.fill();
      context.stroke();
      context.fillStyle = colors.red;
      context.fillRect(screenX + 7, obstacle.height - 14, obstacle.width - 14, 7);
    }
    context.restore();
  }

  function drawObstacles(context, obstacles, cameraX) {
    for (const obstacle of obstacles) {
      const screenX = obstacle.x - cameraX;
      if (screenX + obstacle.width < -20 || screenX > WIDTH + 20) {
        continue;
      }
      if (obstacle.fromTop) {
        drawCeilingObstacle(context, obstacle, screenX);
      } else {
        drawFloorObstacle(context, obstacle, screenX);
      }
    }
  }

  function drawPickle(context, x, y, averageVolume, time) {
    const run = Math.sin(time / 75);
    const bob = Math.abs(Math.sin(time / 150)) * 2;
    const loud = averageVolume > 0.8;
    const quiet = averageVolume < 0.2;
    const bodyX = x + 4;
    const bodyY = y - bob;

    context.save();
    context.strokeStyle = colors.ink;
    context.lineWidth = 4;
    context.lineCap = "round";

    context.beginPath();
    context.moveTo(bodyX + 13, bodyY + 48);
    context.lineTo(bodyX + 8 - run * 5, bodyY + 59);
    context.moveTo(bodyX + 31, bodyY + 48);
    context.lineTo(bodyX + 37 + run * 5, bodyY + 59);
    context.stroke();

    context.fillStyle = colors.green;
    context.beginPath();
    context.ellipse(bodyX + 22, bodyY + 25, 19, 27, -0.12, 0, Math.PI * 2);
    context.fill();
    context.stroke();

    context.fillStyle = colors.lime;
    context.globalAlpha = 0.68;
    context.beginPath();
    context.ellipse(bodyX + 15, bodyY + 20, 6, 18, -0.25, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;

    context.fillStyle = colors.greenDark;
    for (const [bx, by, radius] of [[12, 31, 2], [30, 36, 2], [34, 12, 1.8], [9, 16, 1.5]]) {
      context.beginPath();
      context.arc(bodyX + bx, bodyY + by, radius, 0, Math.PI * 2);
      context.fill();
    }

    context.fillStyle = colors.cream;
    context.beginPath();
    context.arc(bodyX + 14, bodyY + 16, 7, 0, Math.PI * 2);
    context.arc(bodyX + 29, bodyY + 15, 7, 0, Math.PI * 2);
    context.fill();
    context.stroke();

    const pupilY = loud ? -2 : quiet ? 2 : 0;
    context.fillStyle = colors.ink;
    context.beginPath();
    context.arc(bodyX + 15, bodyY + 16 + pupilY, 3, 0, Math.PI * 2);
    context.arc(bodyX + 28, bodyY + 15 + pupilY, 3, 0, Math.PI * 2);
    context.fill();

    context.beginPath();
    if (loud) {
      context.arc(bodyX + 22, bodyY + 34, 5, 0, Math.PI * 2);
    } else if (quiet) {
      context.moveTo(bodyX + 17, bodyY + 36);
      context.lineTo(bodyX + 27, bodyY + 36);
    } else {
      context.arc(bodyX + 22, bodyY + 31, 7, 0.1, Math.PI - 0.1);
    }
    context.stroke();
    context.restore();
  }

  function create(canvas) {
    const context = canvas.getContext("2d");
    let state = null;
    let displayX = 80;
    let displayY = WORLD_HEIGHT / 2;
    let animationFrame = 0;

    function draw(time) {
      if (state && context) {
        displayX += (state.character.x - displayX) * 0.24;
        displayY += (state.character.y - displayY) * 0.28;
        const cameraX = Math.max(0, displayX - 150);

        context.clearRect(0, 0, WIDTH, HEIGHT);
        drawWall(context, cameraX);
        drawCounter(context, cameraX);
        drawCeilingDanger(context, state.averageVolume);
        drawTargetLine(context, state.averageVolume);
        drawObstacles(context, state.obstacles, cameraX);
        drawPickle(
          context,
          displayX - cameraX,
          GROUND_Y - displayY - PICKLE_HEIGHT,
          state.averageVolume,
          time,
        );
      }
      animationFrame = requestAnimationFrame(draw);
    }

    animationFrame = requestAnimationFrame(draw);
    return {
      setState(nextState) {
        if (!state || nextState.levelSeed !== state.levelSeed || nextState.tick < state.tick) {
          displayX = nextState.character.x;
          displayY = nextState.character.y;
        }
        state = nextState;
      },
      destroy() {
        cancelAnimationFrame(animationFrame);
      },
    };
  }

  globalThis.PickleGameRenderer = { create };
})();
