import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrandingTab } from '../BrandingTab';
import * as brandingContext from '@/lib/branding-context';
import * as brandingClient from '@/lib/branding';
import { DEFAULT_BRANDING, type PutBrandingInput } from '@/lib/branding';

let putSpy: MockInstance<(input: PutBrandingInput) => Promise<void>>;

beforeEach(() => {
  vi.spyOn(brandingContext, 'useBranding').mockReturnValue({
    branding: DEFAULT_BRANDING,
    loaded: true,
    refresh: () => {},
  });
  putSpy = vi
    .spyOn(brandingClient, 'putBranding')
    .mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

function pngFile(): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  return new File([bytes], 'logo.png', { type: 'image/png' });
}

describe('BrandingTab', () => {
  it('saves the product name', async () => {
    render(<BrandingTab />);
    const nameInput = screen.getByLabelText(/product name/i);
    fireEvent.change(nameInput, { target: { value: 'Canopy AI' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(putSpy.mock.calls[0]?.[0]).toMatchObject({ name: 'Canopy AI' });
  });

  it('uploads a chosen light logo as base64', async () => {
    render(<BrandingTab />);
    const input = screen.getByTestId('light-logo-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile()] } });
    await waitFor(() => expect(screen.getByText(/logo\.png/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    const arg = putSpy.mock.calls[0]?.[0] as {
      light?: { contentType: string; dataBase64: string };
    };
    expect(arg.light?.contentType).toBe('image/png');
    expect(typeof arg.light?.dataBase64).toBe('string');
    expect((arg.light?.dataBase64.length ?? 0) > 0).toBe(true);
  });

  it('rejects a disallowed file type and does not stage it', async () => {
    render(<BrandingTab />);
    const input = screen.getByTestId('light-logo-input') as HTMLInputElement;
    const pdf = new File([new Uint8Array([1, 2, 3])], 'bad.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(input, { target: { files: [pdf] } });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    // The rejected file is not staged → no light field sent.
    expect(putSpy.mock.calls[0]?.[0]).not.toHaveProperty('light');
  });

  it('clears all branding back to defaults', async () => {
    render(<BrandingTab />);
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(putSpy.mock.calls[0]?.[0]).toEqual({
      name: '',
      logoType: 'full',
      light: null,
      dark: null,
    });
  });
});
