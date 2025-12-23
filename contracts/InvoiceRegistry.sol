// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract InvoiceRegistry {
  enum Status {
    Open,
    Paid
  }

  address public owner;

  struct Invoice {
    uint256 number;
    bytes32 invoiceId;
    address payee;
    address currency;
    uint256 amount;
    uint256 dueDate;
    Status status;
    bytes32 paidTxHash;
  }

  uint256 public nextInvoiceNumber = 1;

  mapping(uint256 => Invoice) private invoices;
  mapping(address => uint256[]) private invoicesByPayee;

  event InvoiceCreated(
    uint256 indexed number,
    address indexed payee,
    address indexed currency,
    uint256 amount,
    uint256 dueDate,
    bytes32 invoiceId
  );
  event InvoicePaid(uint256 indexed number, bytes32 txHash);

  modifier onlyOwner() {
    require(msg.sender == owner, "not owner");
    _;
  }

  constructor() {
    owner = msg.sender;
  }

  function createInvoice(
    address payee,
    address currency,
    uint256 amount,
    uint256 dueDate,
    bytes32 invoiceId
  ) external returns (uint256) {
    require(payee != address(0), "payee=0");
    require(currency != address(0), "currency=0");
    require(amount > 0, "amount=0");
    require(dueDate > block.timestamp, "dueDate<=now");

    uint256 number = nextInvoiceNumber++;
    invoices[number] = Invoice({
      number: number,
      invoiceId: invoiceId,
      payee: payee,
      currency: currency,
      amount: amount,
      dueDate: dueDate,
      status: Status.Open,
      paidTxHash: bytes32(0)
    });
    invoicesByPayee[payee].push(number);

    emit InvoiceCreated(number, payee, currency, amount, dueDate, invoiceId);
    return number;
  }

  function getInvoice(uint256 number) external view returns (Invoice memory) {
    return invoices[number];
  }

  function getInvoicesByPayee(address payee) external view returns (uint256[] memory) {
    return invoicesByPayee[payee];
  }

  function markPaid(uint256 number, bytes32 txHash) external onlyOwner {
    Invoice storage invoice = invoices[number];
    require(invoice.number != 0, "invoice not found");
    require(invoice.status == Status.Open, "already paid");
    invoice.status = Status.Paid;
    invoice.paidTxHash = txHash;
    emit InvoicePaid(number, txHash);
  }
}
