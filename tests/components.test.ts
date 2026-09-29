// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { avatar, fieldLabel, meter, meterRow, sectionTitle, status, tag } from '../src/renderer/src/ui/components'

describe('calm kit factories', () => {
  it('meter() with a known value is a role=meter with aria-valuenow and sets --value via the CSSOM', () => {
    const node = meter(42.4, 'warn', 'Plan window')
    expect(node.getAttribute('role')).toBe('meter')
    expect(node.getAttribute('aria-valuenow')).toBe('42')
    expect(node.getAttribute('aria-valuemin')).toBe('0')
    expect(node.getAttribute('aria-valuemax')).toBe('100')
    expect(node.getAttribute('aria-label')).toBe('Plan window')
    expect(node.className).toBe('meter warn')
    expect(node.style.getPropertyValue('--value')).toBe('42.4%')
    expect(node.querySelector('.meter-track > .meter-fill')).not.toBeNull()
  })

  it('meter() clamps out-of-range values', () => {
    expect(meter(180).getAttribute('aria-valuenow')).toBe('100')
    expect(meter(-5).getAttribute('aria-valuenow')).toBe('0')
  })

  it('meter() with an unknown value is a labelled img, never a value-less meter', () => {
    for (const node of [meter(undefined, 'accent', 'Plan window'), meter(Number.NaN)]) {
      expect(node.getAttribute('role')).toBe('img')
      expect(node.hasAttribute('aria-valuenow')).toBe(false)
      expect(node.style.getPropertyValue('--value')).toBe('')
      expect(node.getAttribute('aria-label')).toMatch(/not reported/i)
    }
    expect(meter(undefined, 'accent', 'Plan window').getAttribute('aria-label')).toBe('Plan window: not reported')
  })

  it('status() with text carries the tone class and no aria override', () => {
    const node = status('ok', 'Signed in')
    expect(node.className).toBe('status ok')
    expect(node.textContent).toBe('Signed in')
    expect(node.hasAttribute('aria-label')).toBe(false)
  })

  it('status() with an empty label is a dot-only img carrying aria-label', () => {
    const named = status('running', '', { ariaLabel: 'Running: refactor auth' })
    expect(named.getAttribute('role')).toBe('img')
    expect(named.getAttribute('aria-label')).toBe('Running: refactor auth')
    expect(status('danger', '').getAttribute('aria-label')).toBe('Error')
  })

  it('meterRow() renders label, meter and readout in that order', () => {
    const row = meterRow('Task affinity', 60, '+12', 'ok')
    expect([...row.children].map((child) => child.className)).toEqual(['meter-label', 'meter ok', 'meter-readout'])
    expect(row.children[0].textContent).toBe('Task affinity')
    expect(row.children[1].getAttribute('aria-valuenow')).toBe('60')
    expect(row.children[1].getAttribute('aria-label')).toBe('Task affinity')
    expect(row.children[2].textContent).toBe('+12')
  })

  it('avatar() uppercases and clamps to two characters', () => {
    expect(avatar('cx').textContent).toBe('CX')
    expect(avatar('  claude code ').textContent).toBe('CL')
    expect(avatar('a').textContent).toBe('A')
    expect(avatar('cx').getAttribute('aria-hidden')).toBe('true')
    expect(avatar('cx', 'Codex').getAttribute('aria-label')).toBe('Codex')
  })

  it('tag() never uppercases the label', () => {
    const node = tag('frontier tier')
    expect(node.className).toBe('tag')
    expect(node.textContent).toBe('frontier tier')
    expect(tag('Edit').textContent).toBe('Edit')
  })

  it('sectionTitle() and fieldLabel() emit the kit classes', () => {
    expect(sectionTitle('Route').className).toBe('section-title')
    expect(sectionTitle('Route').tagName).toBe('H3')
    expect(sectionTitle('Route', 'div').tagName).toBe('DIV')
    expect(fieldLabel('Model').tagName).toBe('SPAN')
    const bound = fieldLabel('Model', 'model-input')
    expect(bound.tagName).toBe('LABEL')
    expect(bound.getAttribute('for')).toBe('model-input')
  })
})
