export const invoiceRegistryAbi = [
  {
    type: 'function',
    name: 'createInvoice',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'payee', type: 'address' },
      { name: 'currency', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'dueDate', type: 'uint256' },
      { name: 'invoiceId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getInvoice',
    stateMutability: 'view',
    inputs: [{ name: 'number', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'number', type: 'uint256' },
          { name: 'invoiceId', type: 'bytes32' },
          { name: 'payee', type: 'address' },
          { name: 'currency', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'dueDate', type: 'uint256' },
          { name: 'status', type: 'uint8' },
          { name: 'paidTxHash', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getInvoicesByPayee',
    stateMutability: 'view',
    inputs: [{ name: 'payee', type: 'address' }],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'nextInvoiceNumber',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'markPaid',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'number', type: 'uint256' },
      { name: 'txHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const
