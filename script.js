// 等待所有资源（包括 Tone.js）加载完毕后再执行
window.addEventListener('load', () => {
    // 获取 DOM 元素
    const canvas = document.getElementById('doodle-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); // willReadFrequently 优化 getImageData
    const colorPalette = document.getElementById('color-palette');
    const playButton = document.getElementById('play-button');
    const stopButton = document.getElementById('stop-button');
    const clearButton = document.getElementById('clear-button');
    const messageBox = document.getElementById('message-box');

    // 绘图状态
    let isDrawing = false;
    let currentColor = '#000000'; // 默认颜色
    let currentBrushSize = 5;

    // 音频设置
    let isAudioReady = false;
    const TIME_STEPS = 64; // 时间步长（精细度）
    const LOOP_DURATION_SECONDS = 8; // 循环总时长
    const MIN_NOTE = 36; // C2 (MIDI)
    const MAX_NOTE = 96; // C7 (MIDI)
    const NOTE_RANGE = MAX_NOTE - MIN_NOTE;
    
    // 检查 Tone 是否已定义
    if (typeof Tone === 'undefined') {
        console.error("Tone.js未能成功加载！");
        showMessage("错误：音频库未能加载，请检查网络连接或刷新页面。");
        return; // 无法继续执行
    }

    // 将所有合成器改为 PolySynth (复音合成器)
    const synths = {
        '#EF4444': new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'triangle' } }).toDestination(),
        '#3B82F6': new Tone.PolySynth(Tone.FMSynth, { harmonicity: 2, modulationIndex: 10 }).toDestination(),
        '#22C55E': new Tone.PolySynth(Tone.AMSynth, { harmonicity: 1.5 }).toDestination(),
        '#F97316': new Tone.PolySynth(Tone.PluckSynth).toDestination(),
        '#000000': new Tone.PolySynth(Tone.MembraneSynth, { pitchDecay: 0.05, octaves: 10 }).toDestination(),
    };
    
    // 将 synths 的音量调低，防止声音过大
    Object.values(synths).forEach(synth => {
        synth.volume.value = -12; // 降低 12 dB
    });

    // 预先计算颜色的 RGB 值，用于像素匹配
    const colorMap = Object.keys(synths).map(hex => ({
        hex: hex,
        rgb: hexToRgb(hex)
    }));

    // --- 1. 画布绘图逻辑 ---

    function getEventPosition(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        let clientX, clientY;
        if (e.touches) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }
        
        return {
            x: (clientX - rect.left) * scaleX,
            y: (clientY - rect.top) * scaleY
        };
    }

    function startDrawing(e) {
        isDrawing = true;
        const { x, y } = getEventPosition(e);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineWidth = currentBrushSize;
        ctx.strokeStyle = currentColor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        // 立即绘制一个点，以便单击也能生效
        ctx.lineTo(x, y);
        ctx.stroke();

        // 为 'draw' 事件准备
        ctx.beginPath();
        ctx.moveTo(x, y);
    }

    function draw(e) {
        if (!isDrawing) return;
        // 阻止默认滚动行为
        e.preventDefault(); 
        
        const { x, y } = getEventPosition(e);
        ctx.lineTo(x, y);
        ctx.stroke();

        // 为下一段笔画开始新路径，这样更高效
        ctx.beginPath();
        ctx.moveTo(x, y);
    }



    function stopDrawing() {
        if (isDrawing) {
            isDrawing = false;
        }
    }

    // 电脑端事件
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseleave', stopDrawing);

    // 移动端触摸事件
    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault(); // 阻止缩放等
        startDrawing(e);
    });
    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault(); // 阻止滚动
        draw(e);
    });
    canvas.addEventListener('touchend', stopDrawing);
    canvas.addEventListener('touchcancel', stopDrawing);


    // --- 2. 控制逻辑 ---

    // 颜色选择
    colorPalette.addEventListener('click', (e) => {
        const target = e.target;
        if (target.classList.contains('color-brush')) {
            currentColor = target.dataset.color;
            currentBrushSize = (currentColor === '#000000') ? 8 : 5; // 黑色画笔粗一点

            // 更新选中样式
            colorPalette.querySelectorAll('.color-brush').forEach(brush => {
                brush.classList.remove('selected');
            });
            target.classList.add('selected');
        }
    });

    // 清除画布
    clearButton.addEventListener('click', () => {
        ctx.fillStyle = 'white'; // 假设背景是白色
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    });
    
    // 播放按钮
    playButton.addEventListener('click', async () => {
        // 启动 Web Audio API (必须由用户操作触发)
        if (!isAudioReady) {
            try {
                await Tone.start();
                isAudioReady = true;
                console.log('音频已准备就绪!');
                playButton.textContent = '🔄 重新生成并播放';
            } catch (err) {
                console.error('音频启动失败:', err);
                showMessage('音频启动失败，请刷新页面重试。');
                return;
            }
        }
        
        // 停止当前正在播放的音乐
        Tone.Transport.stop();
        Tone.Transport.cancel(0); // 清除所有已安排的事件

        // 扫描画布并按颜色分组获取音符事件
        const allEventsByColor = scanCanvas();
        
        // 为每种颜色创建一个 Tone.Part，并使用复音合成器
        for (const hex in allEventsByColor) {
            const synth = synths[hex];
            const notesForThisColor = allEventsByColor[hex]; // 这是一个事件数组

            if (notesForThisColor.length > 0) {
                new Tone.Part((time, value) => {
                    // value.notes 是一个音符频率数组 (e.g., [261.6, 329.6])
                    synth.triggerAttackRelease(value.notes, value.duration, time);
                }, notesForThisColor).start(0);
            }
        }

        // 设置 Tone.Transport 循环
        Tone.Transport.loop = true;
        Tone.Transport.loopStart = 0;
        Tone.Transport.loopEnd = `${LOOP_DURATION_SECONDS}s`; // 循环时长
        
        // 启动播放
        Tone.Transport.start();
    });

    // 停止按钮
    stopButton.addEventListener('click', () => {
        Tone.Transport.stop();
        // 使用 releaseAll() 来停止 PolySynth
        Object.values(synths).forEach(synth => {
            synth.releaseAll();
        });
    });


    // --- 3. 音频处理逻辑 ---

    // 重构 scanCanvas 以将同一时间的音符分组
    function scanCanvas() {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        // 按颜色初始化事件数组
        const eventsByColor = {};
        colorMap.forEach(c => eventsByColor[c.hex] = []);

        const stepWidth = canvas.width / TIME_STEPS;
        const noteHeight = canvas.height / NOTE_RANGE;

        // 遍历时间步 (X 轴)
        for (let xStep = 0; xStep < TIME_STEPS; xStep++) {
            const time = (xStep / TIME_STEPS) * LOOP_DURATION_SECONDS;
            
            // 临时存储当前时间步的音符（按颜色）
            const notesForThisStep = {};
            colorMap.forEach(c => notesForThisStep[c.hex] = []);

            // 遍历音高 (Y 轴)
            for (let yNote = 0; yNote < NOTE_RANGE; yNote++) {
                const sampleY = Math.floor(yNote * noteHeight + noteHeight / 2);
                const sampleX = Math.floor(xStep * stepWidth + stepWidth / 2); // X采样点
                
                // 获取像素索引
                const pixelIndex = (sampleY * canvas.width + sampleX) * 4;
                const r = data[pixelIndex];
                const g = data[pixelIndex + 1];
                const b = data[pixelIndex + 2];
                const a = data[pixelIndex + 3];

                // 检查像素是否可见 (Alpha > 50%)
                if (a > 128) {
                    // 找到最接近的颜色
                    const closestColor = findClosestColor(r, g, b);
                    
                    if (closestColor) {
                        // Y 轴 0 (顶部) 对应高音, Y 轴 canvas.height (底部) 对应低音
                        const noteMidi = MAX_NOTE - yNote;
                        const freq = Tone.mtof(noteMidi); // MIDI 转 频率

                        // 将音符添加到当前时间步的数组中
                        notesForThisStep[closestColor.hex].push(freq);
                    }
                }
            }

            // *在*检查完所有 Y 轴音高后，将此时间步的音符（和弦）添加到主事件列表
            for (const hex in notesForThisStep) {
                if (notesForThisStep[hex].length > 0) {
                    eventsByColor[hex].push({
                        time: time,
                        notes: notesForThisStep[hex], // 这是一个音符数组
                        duration: '16n' // 16分音符
                    });
                }
            }
        }
        return eventsByColor; // 返回按颜色分类的对象
    }

    // --- 4. 辅助函数 ---

    // 16进制转RGB
    function hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }

    // 计算两种颜色之间的“距离”
    function colorDistance(rgb1, rgb2) {
        return Math.sqrt(
            Math.pow(rgb1.r - rgb2.r, 2) +
            Math.pow(rgb1.g - rgb2.g, 2) +
            Math.pow(rgb1.b - rgb2.b, 2)
        );
    }

    // 找到最接近的预定义颜色
    function findClosestColor(r, g, b) {
        let minDistance = Infinity;
        let closest = null;

        for (const color of colorMap) {
            const distance = colorDistance(color.rgb, { r, g, b });
            if (distance < minDistance) {
                minDistance = distance;
                closest = color;
            }
        }
        
        // 设置一个阈值，防止将抗锯齿的灰色像素也匹配上
        // 距离 100 以内，我们认为它是一个有效的匹配
        return (minDistance < 100) ? closest : null; 
    }

    // 显示提示消息
    function showMessage(msg) {
        messageBox.textContent = msg;
        messageBox.classList.remove('hidden');
        setTimeout(() => {
            messageBox.classList.add('hidden');
        }, 3000);
    }

    // 初始时清除画布（填充为白色背景）
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 添加一个日志，确认脚本已正确加载和执行
    console.log("绘图变音频应用已成功加载并初始化。");
});

