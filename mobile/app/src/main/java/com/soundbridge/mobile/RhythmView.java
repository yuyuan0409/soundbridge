package com.soundbridge.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.SystemClock;
import android.util.AttributeSet;
import android.view.View;

/**
 * A radial spectrum ring that reacts to the outgoing mixed audio. It mirrors
 * the circular rhythm visual used by the web listener UI.
 */
public class RhythmView extends View {
    private final Paint barPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ringPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint discPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint titlePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint subtitlePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private RadialGradient discGradient;

    private float level = 0f;
    private float bass = 0f;
    private float displayLevel = 0f;
    private float beat = 0f;
    private float phase = 0f;
    private boolean active = false;
    private long lastBeatAt = 0;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            phase += 0.045f;
            beat *= 0.9f;
            invalidate();
            if (active) postOnAnimation(this);
        }
    };

    public RhythmView(Context context) {
        super(context);
        init();
    }

    public RhythmView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    public RhythmView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        init();
    }

    private void init() {
        setLayerType(LAYER_TYPE_SOFTWARE, null);
        barPaint.setStyle(Paint.Style.STROKE);
        barPaint.setStrokeCap(Paint.Cap.ROUND);
        ringPaint.setStyle(Paint.Style.STROKE);
        ringPaint.setStrokeWidth(dp(1));
        ringPaint.setColor(Color.argb(26, 255, 255, 255));
        discPaint.setStyle(Paint.Style.FILL);
        titlePaint.setColor(Color.rgb(231, 228, 220));
        titlePaint.setTextSize(sp(12));
        titlePaint.setTextAlign(Paint.Align.CENTER);
        titlePaint.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        subtitlePaint.setColor(Color.rgb(120, 132, 148));
        subtitlePaint.setTextSize(sp(8));
        subtitlePaint.setTextAlign(Paint.Align.CENTER);
        subtitlePaint.setLetterSpacing(0.18f);
        subtitlePaint.setTypeface(Typeface.MONOSPACE);
    }

    public void setRhythm(float newLevel, float newBass, boolean isActive) {
        float clampedLevel = Math.max(0f, Math.min(1f, newLevel));
        float clampedBass = Math.max(0f, Math.min(1f, newBass));
        displayLevel += (clampedLevel - displayLevel) * 0.35f;
        level = clampedLevel;
        bass = clampedBass;

        long now = SystemClock.elapsedRealtime();
        if (isActive && bass > 0.4f && now - lastBeatAt > 280) {
            beat = 1f;
            lastBeatAt = now;
        }
        setActive(isActive);
        invalidate();
    }

    public void setActive(boolean value) {
        if (active == value) return;
        active = value;
        removeCallbacks(ticker);
        if (active) postOnAnimation(ticker);
        invalidate();
    }

    @Override
    protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        float maxRadius = Math.min(width, height) / 2f - dp(9);
        float innerRadius = maxRadius * 0.64f;
        discGradient = new RadialGradient(
                width / 2f,
                height / 2f,
                innerRadius,
                new int[]{Color.argb(38, 255, 126, 94), Color.argb(6, 8, 12, 19)},
                new float[]{0f, 1f},
                Shader.TileMode.CLAMP
        );
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float width = getWidth();
        float height = getHeight();
        float centerX = width / 2f;
        float centerY = height / 2f;
        float maxRadius = Math.min(width, height) / 2f - dp(9);
        float innerRadius = maxRadius * 0.64f;

        int accent = active ? Color.rgb(255, 126, 94) : Color.rgb(106, 115, 130);
        int accentAlpha = active ? 255 : 110;

        discPaint.setShader(discGradient);
        canvas.drawCircle(centerX, centerY, innerRadius, discPaint);
        discPaint.setShader(null);

        ringPaint.setColor(Color.argb(active ? 38 : 22, 255, 255, 255));
        canvas.drawCircle(centerX, centerY, innerRadius, ringPaint);
        canvas.drawCircle(centerX, centerY, maxRadius, ringPaint);

        int bars = 64;
        for (int index = 0; index < bars; index++) {
            float angle = (float) (index * Math.PI * 2 / bars - Math.PI / 2 + phase * 0.05);
            float variation = 0.62f + 0.38f * Math.abs((float) Math.sin(index * 1.37f + phase * 1.8f));
            float energy = active
                    ? Math.min(1f, displayLevel * 0.7f + bass * 0.55f + beat * 0.16f)
                    : 0f;
            float length = active ? dp(3) + energy * (maxRadius - innerRadius) * 0.78f * variation : dp(3);
            float start = innerRadius + dp(3);
            float end = start + length;
            float x1 = centerX + (float) Math.cos(angle) * start;
            float y1 = centerY + (float) Math.sin(angle) * start;
            float x2 = centerX + (float) Math.cos(angle) * end;
            float y2 = centerY + (float) Math.sin(angle) * end;

            int alpha = active
                    ? Math.min(255, 95 + (int) (energy * 150))
                    : 62;
            int color = Color.argb(alpha, Color.red(accent), Color.green(accent), Color.blue(accent));
            barPaint.setColor(color);
            barPaint.setStrokeWidth(dp(active ? 2f : 1.2f));
            canvas.drawLine(x1, y1, x2, y2, barPaint);
        }

        if (active) {
            barPaint.setColor(Color.argb(160, 255, 160, 128));
            barPaint.setStrokeWidth(dp(1.2f));
            float pulseRadius = innerRadius - dp(4) + displayLevel * dp(4) + beat * dp(2);
            canvas.drawCircle(centerX, centerY, pulseRadius, barPaint);
        }

        String title = active ? "手机声音" : "等待共享";
        String subtitle = active ? "LIVE" : "STANDBY";
        canvas.drawText(title, centerX, centerY + dp(2), titlePaint);
        subtitlePaint.setColor(active ? Color.argb(accentAlpha, 255, 176, 150) : Color.rgb(104, 116, 132));
        canvas.drawText(subtitle, centerX, centerY + dp(17), subtitlePaint);
    }

    @Override
    protected void onDetachedFromWindow() {
        removeCallbacks(ticker);
        super.onDetachedFromWindow();
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }

    private float sp(float value) {
        return value * getResources().getDisplayMetrics().scaledDensity;
    }
}
