import physicsModels from './physics-models.json' with { type: 'json' };

export const physicsIols = physicsModels;
export type PhysicsIolId = keyof typeof physicsIols;

export const acuityIols = {
  sn60at: { label: 'Alcon AcrySof SN60AT', modelCodes: ['SN60AT'], design: 'spherical monofocal', curveId: null },
  sn60wf: { label: 'Alcon AcrySof IQ SN60WF', modelCodes: ['SN60WF'], design: 'aspheric monofocal', curveId: null },
  acrysof_iq_vivity: { label: 'Alcon AcrySof IQ Vivity', modelCodes: ['DFT015', 'DAT015'], design: 'refractive EDOF', curveId: 'vivity' }
} as const;
export type AcuityIolId = keyof typeof acuityIols;
