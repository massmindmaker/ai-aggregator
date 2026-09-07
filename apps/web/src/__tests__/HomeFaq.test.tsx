import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import HomeFaq from '../components/home/HomeFaq';

describe('HomeFaq disclosure accessibility', () => {
  it('links stable controls and regions while exposing only the open answer', () => {
    const { rerender } = render(<HomeFaq />);
    const firstButton = screen.getByRole('button', {
      name: 'Чем вы лучше Replicate или Hugging Face?',
    });
    const secondButton = screen.getByRole('button', {
      name: 'Как подключить модель за 2 минуты?',
    });
    const firstPanelId = firstButton.getAttribute('aria-controls');
    const secondPanelId = secondButton.getAttribute('aria-controls');

    expect(firstPanelId).toBeTruthy();
    expect(secondPanelId).toBeTruthy();
    expect(firstPanelId).not.toBe(secondPanelId);

    const firstPanel = document.getElementById(firstPanelId!);
    const secondPanel = document.getElementById(secondPanelId!);
    expect(firstButton).toHaveAttribute('aria-expanded', 'true');
    expect(firstPanel).toHaveAttribute('role', 'region');
    expect(firstPanel).toHaveAttribute('aria-labelledby', firstButton.id);
    expect(firstPanel).toHaveAttribute('aria-hidden', 'false');
    expect(secondButton).toHaveAttribute('aria-expanded', 'false');
    expect(secondPanel).toHaveAttribute('role', 'region');
    expect(secondPanel).toHaveAttribute('aria-labelledby', secondButton.id);
    expect(secondPanel).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(secondButton);

    expect(firstButton).toHaveAttribute('aria-expanded', 'false');
    expect(firstPanel).toHaveAttribute('aria-hidden', 'true');
    expect(secondButton).toHaveAttribute('aria-expanded', 'true');
    expect(secondPanel).toHaveAttribute('aria-hidden', 'false');

    rerender(<HomeFaq />);
    expect(firstButton).toHaveAttribute('aria-controls', firstPanelId);
    expect(secondButton).toHaveAttribute('aria-controls', secondPanelId);
  });
});
